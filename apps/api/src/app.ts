import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { rootLogger } from '@nse/core';
import type { Container } from './container';
import { authenticate } from './middleware/auth';
import { errorHandler, notFound } from './middleware/errorHandler';
import { rateLimit } from './middleware/rateLimit';
import { requestId } from './middleware/requestId';
import { buildOpenApiDocument } from './openapi';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { instrumentRoutes, quoteRoutes } from './routes/instruments';
import { orderRoutes } from './routes/orders';
import { portfolioRoutes } from './routes/portfolio';

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Caddy

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: rootLogger,
      genReqId: (req) => req.id as string,
      customProps: (req) => ({ requestId: req.id, userId: (req as express.Request).userId }),
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  const spec = buildOpenApiDocument();
  app.get('/docs/openapi.json', (_req, res) => res.json(spec));
  // Swagger UI needs inline scripts/styles, so it gets its own relaxed CSP; everything else uses helmet's defaults.
  app.use('/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'NSE Paper Trading API' }));
  app.use(helmet());
  app.use(
    cors({
      origin: c.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.use(healthRoutes(c));

  const v1 = express.Router();
  const authLimiter = rateLimit(c.redis, { name: 'auth', limit: c.config.RATE_LIMIT_AUTH_PER_MIN, windowSeconds: 60, key: (req) => req.ip ?? 'unknown' });
  const orderLimiter = rateLimit(c.redis, { name: 'orders', limit: c.config.RATE_LIMIT_ORDERS_PER_MIN, windowSeconds: 60, key: (req) => req.userId ?? req.ip ?? 'unknown' });

  v1.use('/auth/login', authLimiter);
  v1.use('/auth/register', authLimiter);
  v1.use('/auth', authRoutes(c));
  v1.use('/instruments', instrumentRoutes(c));
  v1.use('/quotes', quoteRoutes(c));
  v1.post('/orders', authenticate(c.auth), orderLimiter);
  v1.use('/orders', authenticate(c.auth), orderRoutes(c));
  v1.use('/portfolio', authenticate(c.auth), portfolioRoutes(c));
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

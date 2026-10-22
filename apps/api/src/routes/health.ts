import { Router } from 'express';
import type { Container } from '../container';
import { handler } from '../middleware/handler';

export function healthRoutes(c: Container): Router {
  const r = Router();
  r.get('/health', handler({}, async (_i, _req, res) => res.json({ status: 'ok' })));
  r.get(
    '/ready',
    handler({}, async (_i, _req, res) => {
      const checks = await Promise.allSettled([c.pool.query('SELECT 1'), c.redis.ping()]);
      const [db, redis] = checks.map((x) => (x.status === 'fulfilled' ? 'up' : 'down'));
      const ok = db === 'up' && redis === 'up';
      res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', db, redis });
    }),
  );
  return r;
}

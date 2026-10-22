import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ERROR_CODES,
  LEDGER_REASONS,
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TYPES,
  REJECT_REASONS,
  candlesQuerySchema,
  listOrdersQuerySchema,
  loginSchema,
  placeOrderSchema,
  registerSchema,
  searchQuerySchema,
  symbolSchema,
} from '@nse/shared';

extendZodWithOpenApi(z);

/**
 * The spec is generated from the same zod schemas the routes validate with,
 * so request documentation cannot drift from what the API actually accepts.
 */
const registry = new OpenAPIRegistry();
const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
const secured = [{ [bearer.name]: [] }];

const Error = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string(),
    }),
  }),
);
const User = registry.register('User', z.object({ id: z.string().uuid(), email: z.string(), name: z.string(), createdAt: z.string() }));
const Auth = registry.register('AuthResponse', z.object({ token: z.string(), user: User }));
const Quote = registry.register(
  'Quote',
  z.object({ symbol: z.string(), price: z.number(), previousClose: z.number(), change: z.number(), changePercent: z.number(), asOf: z.string() }),
);
const Instrument = registry.register(
  'InstrumentWithQuote',
  z.object({ symbol: z.string(), name: z.string(), sector: z.string(), quote: Quote.nullable() }),
);
const Candle = registry.register(
  'Candle',
  z.object({ time: z.string().openapi({ example: '2026-10-21' }), open: z.number(), high: z.number(), low: z.number(), close: z.number(), volume: z.number() }),
);
const Order = registry.register(
  'Order',
  z.object({
    id: z.string().uuid(),
    symbol: z.string(),
    side: z.enum(ORDER_SIDES),
    type: z.enum(ORDER_TYPES),
    quantity: z.number().int(),
    limitPrice: z.number().nullable(),
    status: z.enum(ORDER_STATUSES),
    fillPrice: z.number().nullable(),
    rejectReason: z.enum(REJECT_REASONS).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
const OrderEvent = z.object({
  id: z.string(),
  fromStatus: z.enum(ORDER_STATUSES).nullable(),
  toStatus: z.enum(ORDER_STATUSES),
  payload: z.record(z.unknown()),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});
const OrderWithEvents = registry.register('OrderWithEvents', Order.extend({ events: z.array(OrderEvent) }));
const Holding = z.object({
  symbol: z.string(),
  name: z.string(),
  quantity: z.number(),
  avgPrice: z.number(),
  investedValue: z.number(),
  lastPrice: z.number().nullable(),
  currentValue: z.number().nullable(),
  unrealisedPnl: z.number().nullable(),
  realisedPnl: z.number(),
});
const Portfolio = registry.register(
  'Portfolio',
  z.object({
    cash: z.number(),
    investedValue: z.number(),
    currentValue: z.number(),
    unrealisedPnl: z.number(),
    realisedPnl: z.number(),
    totalValue: z.number(),
    holdings: z.array(Holding),
  }),
);
const LedgerEntry = registry.register(
  'LedgerEntry',
  z.object({ id: z.string(), amount: z.number(), reason: z.enum(LEDGER_REASONS), orderId: z.string().nullable(), createdAt: z.string() }),
);

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const err = (description: string) => json(Error, description);
const symbolParam = z.object({ symbol: symbolSchema.openapi({ example: 'RELIANCE' }) });
const idParam = z.object({ id: z.string().uuid() });

registry.registerPath({ method: 'get', path: '/health', tags: ['Platform'], summary: 'Liveness probe', responses: { 200: { description: 'Process is up' } } });
registry.registerPath({ method: 'get', path: '/ready', tags: ['Platform'], summary: 'Readiness probe (checks Postgres and Redis)', responses: { 200: { description: 'Ready' }, 503: { description: 'A dependency is down' } } });

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/register',
  tags: ['Auth'],
  summary: 'Create an account (credited with ₹10,00,000 virtual cash)',
  request: { body: { content: { 'application/json': { schema: registerSchema } } } },
  responses: { 201: json(Auth, 'Registered'), 400: err('Validation error'), 409: err('Email already registered') },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/login',
  tags: ['Auth'],
  summary: 'Log in and receive a JWT',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: { 200: json(Auth, 'Logged in'), 401: err('Invalid credentials') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/me',
  tags: ['Auth'],
  security: secured,
  summary: 'Current user and available cash',
  responses: { 200: json(z.object({ user: User, cash: z.number() }), 'Profile'), 401: err('Not authenticated') },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/instruments',
  tags: ['Market data'],
  summary: 'Search NIFTY 50 instruments (with cached quotes)',
  request: { query: searchQuerySchema },
  responses: { 200: json(z.array(Instrument), 'Matches') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/instruments/top',
  tags: ['Market data'],
  summary: 'Top gainers / losers by % change',
  responses: { 200: json(z.object({ gainers: z.array(Instrument), losers: z.array(Instrument), all: z.array(Instrument) }), 'Movers') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/instruments/{symbol}',
  tags: ['Market data'],
  summary: 'Instrument with latest quote',
  request: { params: symbolParam },
  responses: { 200: json(Instrument, 'Instrument'), 404: err('Unknown symbol') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/instruments/{symbol}/candles',
  tags: ['Market data'],
  summary: 'Daily OHLCV candles',
  request: { params: symbolParam, query: candlesQuerySchema },
  responses: { 200: json(z.array(Candle), 'Candles, oldest first'), 404: err('Unknown symbol') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/quotes',
  tags: ['Market data'],
  summary: 'Batch quotes from the Redis cache (falls back to the provider, then last known price)',
  request: { query: z.object({ symbols: z.string().openapi({ example: 'RELIANCE,TCS,INFY' }) }) },
  responses: { 200: json(z.record(Quote), 'Quotes keyed by symbol'), 400: err('Validation error') },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/orders',
  tags: ['Orders'],
  security: secured,
  summary: 'Place a market or limit order',
  description:
    'Idempotent: retries with the same Idempotency-Key return the original order (200, header Idempotent-Replayed: true). ' +
    'Reusing a key with a different body returns 422. In queue mode the order is returned as VALIDATED with 202 and the ' +
    'execution worker fills it; subscribe to the WebSocket or poll GET /orders/{id}. Business rejections (insufficient ' +
    'funds/holdings, no price) are recorded as REJECTED orders, not HTTP errors.',
  request: {
    headers: z.object({ 'Idempotency-Key': z.string().min(8).max(128).openapi({ example: 'b7f6c1a2-0c1e-4d3a-9f2b-1e8f3c7a9d10' }) }),
    body: { content: { 'application/json': { schema: placeOrderSchema } } },
  },
  responses: {
    201: json(Order, 'Order created and already in a resting/final state (OPEN, FILLED or REJECTED)'),
    202: json(Order, 'Order accepted (VALIDATED) and queued for execution'),
    200: json(Order, 'Idempotent replay of an earlier request'),
    400: err('Validation error or missing Idempotency-Key'),
    401: err('Not authenticated'),
    404: err('Unknown symbol'),
    422: err('Idempotency-Key reused with a different body'),
    429: err('Rate limited'),
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/orders',
  tags: ['Orders'],
  security: secured,
  summary: "List the user's orders, newest first",
  request: { query: listOrdersQuerySchema },
  responses: { 200: json(z.array(Order), 'Orders') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/orders/{id}',
  tags: ['Orders'],
  security: secured,
  summary: 'Order with its full event history',
  request: { params: idParam },
  responses: { 200: json(OrderWithEvents, 'Order'), 404: err('Not found (or not yours)') },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/orders/{id}/cancel',
  tags: ['Orders'],
  security: secured,
  summary: 'Cancel an OPEN order (releases blocked cash)',
  request: { params: idParam },
  responses: { 200: json(Order, 'Cancelled'), 404: err('Not found'), 409: err('Order is not OPEN') },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/portfolio',
  tags: ['Portfolio'],
  security: secured,
  summary: 'Holdings with average price, current value, realised and unrealised P&L',
  responses: { 200: json(Portfolio, 'Portfolio') },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/portfolio/ledger',
  tags: ['Portfolio'],
  security: secured,
  summary: 'Cash ledger entries (DEPOSIT, BUY, SELL, HOLD, RELEASE)',
  request: { query: z.object({ limit: z.number().int().min(1).max(500).optional() }) },
  responses: { 200: json(z.array(LedgerEntry), 'Ledger, newest first') },
});

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'NSE Paper Trading API',
      version: '1.0.0',
      description:
        'Broker-style paper trading for NIFTY 50 stocks. Money values are rupees. Every response carries X-Request-Id; ' +
        'errors share one envelope. Real-time quotes and order updates: WebSocket at /ws (?token=JWT), send ' +
        '{"type":"subscribe","symbols":["RELIANCE"]}.',
    },
    servers: [{ url: '/' }],
  });
}

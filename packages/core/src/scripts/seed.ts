import { Redis } from 'ioredis';
import type { PlaceOrderInput } from '@nse/shared';
import {
  AuthService,
  ExecutionService,
  FakePriceProvider,
  MarketDataService,
  NIFTY_50,
  OrderService,
  PriceIngestService,
  SyncDispatcher,
  YahooPriceProvider,
  createPool,
  instrumentsRepo,
  loadConfig,
  migrate,
  rootLogger,
  usersRepo,
} from '../index';

export const DEMO_USER = { email: 'demo@nsepaper.dev', password: 'Demo@12345', name: 'Demo Trader' };

const DEMO_ORDERS: Array<{ key: string; input: PlaceOrderInput }> = [
  { key: 'seed-demo-0001', input: { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 25 } },
  { key: 'seed-demo-0002', input: { symbol: 'TCS', side: 'BUY', type: 'MARKET', quantity: 10 } },
  { key: 'seed-demo-0003', input: { symbol: 'HDFCBANK', side: 'BUY', type: 'MARKET', quantity: 40 } },
  { key: 'seed-demo-0004', input: { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 30 } },
  { key: 'seed-demo-0005', input: { symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 10 } },
  { key: 'seed-demo-0006', input: { symbol: 'ITC', side: 'BUY', type: 'LIMIT', quantity: 100, limitPrice: 380 } },
];

/**
 * Idempotent seed: NIFTY 50 instruments, daily price history and a demo account
 * with a few trades. Demo orders use fixed Idempotency-Keys, so re-running never duplicates them.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const days = Number(process.env.SEED_HISTORY_DAYS ?? 730);
  const pool = createPool(config.DATABASE_URL, 5);
  const redis = new Redis(config.REDIS_URL);
  try {
    await migrate(pool);
    const retired = await instrumentsRepo.syncUniverse(pool, NIFTY_50);
    rootLogger.info({ count: NIFTY_50.length, retired }, 'instrument universe synced');

    const provider = config.MARKET_DATA_PROVIDER === 'fake' ? new FakePriceProvider() : new YahooPriceProvider();
    const ingest = new PriceIngestService(pool, provider);
    await ingest.ingest(new Date(Date.now() - days * 86_400_000), new Date());

    const marketData = new MarketDataService(redis, provider, config.QUOTE_CACHE_TTL_SECONDS);
    const auth = new AuthService(pool, config);
    const orders = new OrderService(pool, marketData, new SyncDispatcher(new ExecutionService(pool, marketData)));

    const existing = await usersRepo.findByEmail(pool, DEMO_USER.email);
    const userId = existing ? existing.id : (await auth.register(DEMO_USER)).user.id;
    for (const { key, input } of DEMO_ORDERS) {
      const { order } = await orders.placeOrder({ userId, input, idempotencyKey: key, requestId: 'seed' });
      rootLogger.info({ symbol: order.symbol, side: order.side, status: order.status }, 'demo order');
    }
    rootLogger.info({ email: DEMO_USER.email, password: DEMO_USER.password }, 'demo account ready');
  } finally {
    await pool.end();
    await redis.quit();
  }
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'seed failed');
  process.exit(1);
});

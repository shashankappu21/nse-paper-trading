import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import {
  EodService,
  ExecutionService,
  FakePriceProvider,
  MarketDataService,
  OrderService,
  PriceIngestService,
  QueueDispatcher,
  YahooPriceProvider,
  bullConnection,
  createOrderQueue,
  createPool,
  createScheduledQueue,
  loadConfig,
  redisOrderNotifier,
  rootLogger,
} from '@nse/core';
import { registerSchedules } from './schedules';
import { createWorkers } from './workers';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  const provider = config.MARKET_DATA_PROVIDER === 'fake' ? new FakePriceProvider() : new YahooPriceProvider();
  const marketData = new MarketDataService(redis, provider, config.QUOTE_CACHE_TTL_SECONDS);
  const execution = new ExecutionService(pool, marketData, redisOrderNotifier(redis));
  const orderQueue = createOrderQueue(config.REDIS_URL);
  const scheduledQueue = createScheduledQueue(config.REDIS_URL);
  const orders = new OrderService(pool, marketData, new QueueDispatcher(orderQueue));
  const eod = new EodService(pool, new PriceIngestService(pool, provider), execution);

  await registerSchedules(scheduledQueue, config);
  const { close } = createWorkers(
    { pool, execution, eod, marketData, orders },
    { connection: bullConnection(config.REDIS_URL) },
  );

  // Liveness endpoint for container healthchecks.
  const health = createServer(async (_req, res) => {
    try {
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } catch {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"degraded"}');
    }
  });
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 4001);
  health.listen(healthPort);
  rootLogger.info({ provider: provider.name, healthPort }, 'worker started');

  const shutdown = async (signal: string) => {
    rootLogger.info({ signal }, 'worker shutting down (finishing in-flight jobs)');
    setTimeout(() => process.exit(1), 15_000).unref();
    health.close();
    await close();
    await Promise.allSettled([orderQueue.close(), scheduledQueue.close(), pool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

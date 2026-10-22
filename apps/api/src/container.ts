import { Redis } from 'ioredis';
import {
  AuthService,
  ExecutionService,
  FakePriceProvider,
  InstrumentService,
  MarketDataService,
  OrderService,
  PortfolioService,
  SyncDispatcher,
  YahooPriceProvider,
  createPool,
  type Config,
  type OrderDispatcher,
  type Pool,
  type PriceProvider,
} from '@nse/core';

/** Composition root: the only place that knows which concrete implementations are wired together. */
export interface Container {
  config: Config;
  pool: Pool;
  redis: Redis;
  provider: PriceProvider;
  marketData: MarketDataService;
  auth: AuthService;
  orders: OrderService;
  portfolio: PortfolioService;
  instruments: InstrumentService;
  close(): Promise<void>;
}

export function buildContainer(config: Config, overrides: { dispatcher?: OrderDispatcher } = {}): Container {
  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  const provider: PriceProvider = config.MARKET_DATA_PROVIDER === 'fake' ? new FakePriceProvider() : new YahooPriceProvider();
  const marketData = new MarketDataService(redis, provider, config.QUOTE_CACHE_TTL_SECONDS);

  const dispatcher = overrides.dispatcher ?? new SyncDispatcher(new ExecutionService(pool, marketData));

  return {
    config,
    pool,
    redis,
    provider,
    marketData,
    auth: new AuthService(pool, config),
    orders: new OrderService(pool, marketData, dispatcher),
    portfolio: new PortfolioService(pool, marketData),
    instruments: new InstrumentService(pool, marketData),
    async close() {
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}

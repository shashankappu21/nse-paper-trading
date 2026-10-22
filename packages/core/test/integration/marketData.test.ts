import { Redis } from 'ioredis';
import type { QuoteDto } from '@nse/shared';
import { MarketDataService, type PriceProvider, type DailyBar } from '../../src';
import { config } from '../helpers';

class CountingProvider implements PriceProvider {
  readonly name = 'counting';
  calls = 0;
  fail = false;
  price = 100;
  async getQuotes(symbols: string[]): Promise<QuoteDto[]> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    if (this.fail) throw new Error('provider down');
    return symbols.map((symbol) => ({ symbol, price: this.price, previousClose: 99, change: 1, changePercent: 1.01, asOf: new Date().toISOString() }));
  }
  async getDailyHistory(): Promise<DailyBar[]> {
    return [];
  }
}

describe('MarketDataService (Redis cache)', () => {
  let redis: Redis;
  let provider: CountingProvider;
  let svc: MarketDataService;

  beforeAll(() => {
    redis = new Redis(config.REDIS_URL);
  });
  afterAll(() => redis.quit());
  beforeEach(async () => {
    await redis.flushdb();
    provider = new CountingProvider();
    svc = new MarketDataService(redis, provider, 1);
  });

  it('caches quotes: the second read does not hit the provider', async () => {
    await svc.getQuote('TCS');
    await svc.getQuote('TCS');
    expect(provider.calls).toBe(1);
    expect(await redis.ttl('quote:TCS')).toBeGreaterThan(0);
  });

  it('expires after the TTL', async () => {
    await svc.getQuote('TCS');
    await new Promise((r) => setTimeout(r, 1100));
    await svc.getQuote('TCS');
    expect(provider.calls).toBe(2);
  });

  it('collapses concurrent misses into one provider call (single-flight)', async () => {
    await Promise.all(Array.from({ length: 20 }, () => svc.getQuote('INFY')));
    expect(provider.calls).toBe(1);
  });

  it('strict getQuote throws PRICE_UNAVAILABLE when the provider is down and the cache is cold', async () => {
    provider.fail = true;
    await expect(svc.getQuote('TCS')).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  it('getQuotes falls back to the last known price for display when the provider is down', async () => {
    await svc.getQuotes(['TCS']);
    await redis.del('quote:TCS'); // simulate TTL expiry
    provider.fail = true;
    const quotes = await svc.getQuotes(['TCS']);
    expect(quotes.get('TCS')?.price).toBe(100);
  });

  it('refresh with publish broadcasts on the quotes channel', async () => {
    const sub = new Redis(config.REDIS_URL);
    const received = new Promise<string>((resolve) => sub.on('message', (_c, m) => resolve(m)));
    await sub.subscribe('quotes');
    await svc.refresh(['TCS'], { publish: true });
    expect(JSON.parse(await received)[0]).toMatchObject({ symbol: 'TCS', price: 100 });
    await sub.quit();
  });
});

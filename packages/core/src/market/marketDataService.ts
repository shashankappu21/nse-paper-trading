import type { Redis } from 'ioredis';
import type { QuoteDto } from '@nse/shared';
import { Errors } from '../errors';
import { getLogger } from '../logger';
import { QUOTES_CHANNEL, type PriceProvider, type QuoteSource } from './types';

const freshKey = (s: string) => `quote:${s}`;
const lastKey = (s: string) => `quote:last:${s}`;

/**
 * Read-through cache for quotes.
 *  - quote:{SYM}       short TTL; what order fills use
 *  - quote:last:{SYM}  no TTL; last known price, used for display if the provider is down
 * Concurrent misses for the same symbols share one provider call (single-flight),
 * so a burst of orders cannot stampede Yahoo.
 */
export class MarketDataService implements QuoteSource {
  private inflight = new Map<string, Promise<QuoteDto[]>>();

  constructor(
    private readonly redis: Redis,
    private readonly provider: PriceProvider,
    private readonly ttlSeconds: number,
  ) {}

  async getQuote(symbol: string): Promise<QuoteDto> {
    const cached = await this.redis.get(freshKey(symbol));
    if (cached) return JSON.parse(cached) as QuoteDto;
    let fetched: QuoteDto[] = [];
    try {
      fetched = await this.fetch([symbol]);
    } catch (err) {
      getLogger().warn({ err, symbol }, 'quote provider failed');
    }
    const quote = fetched.find((q) => q.symbol === symbol);
    if (!quote) throw Errors.priceUnavailable(symbol);
    return quote;
  }

  async getQuotes(symbols: string[]): Promise<Map<string, QuoteDto>> {
    const out = new Map<string, QuoteDto>();
    if (symbols.length === 0) return out;
    const cached = await this.redis.mget(symbols.map(freshKey));
    const misses: string[] = [];
    symbols.forEach((s, i) => {
      const v = cached[i];
      if (v) out.set(s, JSON.parse(v) as QuoteDto);
      else misses.push(s);
    });
    if (misses.length === 0) return out;

    try {
      for (const q of await this.fetch(misses)) out.set(q.symbol, q);
    } catch (err) {
      getLogger().warn({ err, count: misses.length }, 'quote provider failed, serving last known prices');
    }
    const stillMissing = misses.filter((s) => !out.has(s));
    if (stillMissing.length > 0) {
      const stale = await this.redis.mget(stillMissing.map(lastKey));
      stillMissing.forEach((s, i) => {
        const v = stale[i];
        if (v) out.set(s, JSON.parse(v) as QuoteDto);
      });
    }
    return out;
  }

  /** Fetch from the provider, write both cache keys, and optionally broadcast. */
  async refresh(symbols: string[], opts: { publish?: boolean } = {}): Promise<QuoteDto[]> {
    const quotes = await this.fetch(symbols);
    if (opts.publish && quotes.length > 0) {
      await this.redis.publish(QUOTES_CHANNEL, JSON.stringify(quotes));
    }
    return quotes;
  }

  private fetch(symbols: string[]): Promise<QuoteDto[]> {
    const key = [...symbols].sort().join(',');
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const quotes = await this.provider.getQuotes(symbols);
      if (quotes.length > 0) {
        const pipe = this.redis.pipeline();
        for (const q of quotes) {
          const json = JSON.stringify(q);
          pipe.set(freshKey(q.symbol), json, 'EX', this.ttlSeconds);
          pipe.set(lastKey(q.symbol), json);
        }
        await pipe.exec();
      }
      return quotes;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

import type { Pool } from '../db/pool';
import { getLogger } from '../logger';
import type { PriceProvider } from '../market/types';
import { instrumentsRepo } from '../repositories/instrumentsRepo';
import { pricesRepo } from '../repositories/pricesRepo';

export interface IngestRetryOptions {
  /** Provider calls per symbol before giving up (1 = no retry). */
  attempts: number;
  /** Delay before the first retry; doubles on each further retry. */
  retryDelayMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls daily OHLC bars from the provider into daily_prices (idempotent upserts). */
export class PriceIngestService {
  constructor(
    private readonly pool: Pool,
    private readonly provider: PriceProvider,
    private readonly retry: IngestRetryOptions = { attempts: 3, retryDelayMs: 1000 },
  ) {}

  /** Transient network errors (a DNS blip took out 21 of 50 symbols in one seed) are retried with backoff. */
  private async fetchWithRetry(symbol: string, from: Date, to: Date) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.provider.getDailyHistory(symbol, from, to);
      } catch (err) {
        if (attempt >= this.retry.attempts) throw err;
        await sleep(this.retry.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  async ingest(from: Date, to: Date, symbols?: string[], concurrency = 5): Promise<{ symbols: number; bars: number; failed: string[] }> {
    const log = getLogger().child({ job: 'price-ingest' });
    const list = symbols ?? (await instrumentsRepo.listActive(this.pool)).map((i) => i.symbol);
    let bars = 0;
    const failed: string[] = [];
    const queue = [...list];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
        try {
          // Await first, then add: `bars += await x` reads `bars` before the await and loses
          // increments made by the other concurrent loops.
          const written = await pricesRepo.upsertMany(this.pool, await this.fetchWithRetry(symbol, from, to));
          bars += written;
        } catch (err) {
          failed.push(symbol);
          log.warn({ err, symbol }, 'price ingest failed for symbol');
        }
      }
    });
    await Promise.all(workers);
    const summary = { symbols: list.length, bars, failed: failed.length, provider: this.provider.name };
    if (failed.length > 0) log.error({ ...summary, failedSymbols: failed }, 'price ingest incomplete');
    else log.info(summary, 'price ingest complete');
    return { symbols: list.length, bars, failed };
  }
}

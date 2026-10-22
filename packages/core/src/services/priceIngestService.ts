import type { Pool } from '../db/pool';
import { getLogger } from '../logger';
import type { PriceProvider } from '../market/types';
import { instrumentsRepo } from '../repositories/instrumentsRepo';
import { pricesRepo } from '../repositories/pricesRepo';

/** Pulls daily OHLC bars from the provider into daily_prices (idempotent upserts). */
export class PriceIngestService {
  constructor(
    private readonly pool: Pool,
    private readonly provider: PriceProvider,
  ) {}

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
          const written = await pricesRepo.upsertMany(this.pool, await this.provider.getDailyHistory(symbol, from, to));
          bars += written;
        } catch (err) {
          failed.push(symbol);
          log.warn({ err, symbol }, 'price ingest failed for symbol');
        }
      }
    });
    await Promise.all(workers);
    log.info({ symbols: list.length, bars, failed: failed.length, provider: this.provider.name }, 'price ingest complete');
    return { symbols: list.length, bars, failed };
  }
}

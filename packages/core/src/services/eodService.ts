import type { Pool } from '../db/pool';
import { getLogger } from '../logger';
import { istDateString } from '../market/types';
import type { ExecutionService, SweepResult } from './executionService';
import type { PriceIngestService } from './priceIngestService';

const DAY = 86_400_000;

/**
 * After-close job: ingest the latest daily candles, then sweep OPEN limit orders.
 * It re-ingests and re-sweeps a short look-back window so a missed run (worker down,
 * provider outage) is caught up next time. Both steps are idempotent: candles are
 * upserted and already-filled orders are no longer OPEN.
 */
export class EodService {
  constructor(
    private readonly pool: Pool,
    private readonly ingest: PriceIngestService,
    private readonly execution: ExecutionService,
    private readonly lookbackDays = 5,
  ) {}

  async run(date = istDateString(new Date())): Promise<{ ingested: number; sweeps: SweepResult[] }> {
    const log = getLogger().child({ job: 'eod-close' });
    const end = new Date(`${date}T23:59:59+05:30`);
    const start = new Date(end.getTime() - (this.lookbackDays + 2) * DAY);
    const { bars } = await this.ingest.ingest(start, end);

    const { rows } = await this.pool.query<{ date: string }>(
      `SELECT DISTINCT date FROM daily_prices WHERE date > $1::date - $2::int AND date <= $1::date ORDER BY date`,
      [date, this.lookbackDays],
    );
    const sweeps: SweepResult[] = [];
    for (const r of rows) sweeps.push(await this.execution.sweepLimitOrders(r.date));
    log.info({ date, ingested: bars, sweptDates: sweeps.length, filled: sweeps.reduce((n, s) => n + s.filled, 0) }, 'eod complete');
    return { ingested: bars, sweeps };
  }
}

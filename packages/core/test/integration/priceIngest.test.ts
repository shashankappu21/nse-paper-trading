import { FakePriceProvider, NIFTY_50, PriceIngestService, instrumentsRepo, type Pool } from '../../src';
import { resetDb, testPool } from '../helpers';

describe('PriceIngestService', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = testPool();
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDb(pool));

  it('reports the exact number of bars written across concurrent symbol loops', async () => {
    const svc = new PriceIngestService(pool, new FakePriceProvider());
    // Mon 2026-10-12 .. Fri 2026-10-16 = 5 trading days x 50 symbols
    const res = await svc.ingest(new Date('2026-10-12T06:00:00Z'), new Date('2026-10-16T06:00:00Z'));
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM daily_prices');
    expect(rows[0]!.n).toBe(250);
    expect(res).toEqual({ symbols: 50, bars: 250, failed: [] });
  });

  it('is idempotent: re-ingesting the same window upserts instead of duplicating', async () => {
    const svc = new PriceIngestService(pool, new FakePriceProvider());
    const from = new Date('2026-10-12T06:00:00Z');
    const to = new Date('2026-10-16T06:00:00Z');
    await svc.ingest(from, to);
    await svc.ingest(from, to);
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM daily_prices');
    expect(rows[0]!.n).toBe(250);
  });

  it('generated candles are internally consistent (low <= open,close <= high)', async () => {
    const bars = await new FakePriceProvider().getDailyHistory('TCS', new Date('2026-01-01'), new Date('2026-06-30'));
    expect(bars.length).toBeGreaterThan(100);
    for (const b of bars) {
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
    }
  });
});

describe('instrumentsRepo.syncUniverse', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = testPool();
  });
  afterAll(async () => {
    await instrumentsRepo.syncUniverse(pool, NIFTY_50); // restore the real universe for other suites
    await pool.end();
  });

  it('upserts members and retires symbols that left the index', async () => {
    const withoutTcs = NIFTY_50.filter((i) => i.symbol !== 'TCS');
    const retired = await instrumentsRepo.syncUniverse(pool, withoutTcs);
    expect(retired).toEqual(['TCS']);
    expect((await instrumentsRepo.findBySymbol(pool, 'TCS'))?.active).toBe(false);
    expect((await instrumentsRepo.listActive(pool)).map((i) => i.symbol)).not.toContain('TCS');
    // Re-adding reactivates it
    await instrumentsRepo.syncUniverse(pool, NIFTY_50);
    expect((await instrumentsRepo.findBySymbol(pool, 'TCS'))?.active).toBe(true);
  });
});

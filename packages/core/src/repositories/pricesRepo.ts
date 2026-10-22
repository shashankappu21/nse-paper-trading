import type { Db } from '../db/pool';

export interface DailyBar {
  symbol: string;
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BarRow {
  symbol: string;
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
}

const toBar = (r: BarRow): DailyBar => ({
  symbol: r.symbol,
  date: r.date,
  open: Number(r.open),
  high: Number(r.high),
  low: Number(r.low),
  close: Number(r.close),
  volume: r.volume,
});

export const pricesRepo = {
  async upsertMany(db: Db, bars: DailyBar[]): Promise<number> {
    if (bars.length === 0) return 0;
    const { rowCount } = await db.query(
      `INSERT INTO daily_prices (symbol, date, open, high, low, close, volume)
       SELECT * FROM unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::bigint[])
       ON CONFLICT (symbol, date) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume`,
      [
        bars.map((b) => b.symbol),
        bars.map((b) => b.date),
        bars.map((b) => b.open),
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        bars.map((b) => b.close),
        bars.map((b) => Math.round(b.volume)),
      ],
    );
    return rowCount ?? 0;
  },

  /** Uses the (symbol, date) primary key for a range scan. */
  async range(db: Db, symbol: string, fromDate: string): Promise<DailyBar[]> {
    const { rows } = await db.query<BarRow>(
      'SELECT * FROM daily_prices WHERE symbol = $1 AND date >= $2 ORDER BY date',
      [symbol, fromDate],
    );
    return rows.map(toBar);
  },

  async findBar(db: Db, symbol: string, date: string): Promise<DailyBar | null> {
    const { rows } = await db.query<BarRow>('SELECT * FROM daily_prices WHERE symbol = $1 AND date = $2', [symbol, date]);
    return rows[0] ? toBar(rows[0]) : null;
  },

  /** Most recent two bars per symbol: last close and previous close. */
  async latestTwo(db: Db, symbols: string[]): Promise<Map<string, DailyBar[]>> {
    const { rows } = await db.query<BarRow>(
      `SELECT p.* FROM unnest($1::text[]) AS s(symbol)
       CROSS JOIN LATERAL (
         SELECT * FROM daily_prices d WHERE d.symbol = s.symbol ORDER BY d.date DESC LIMIT 2
       ) p`,
      [symbols],
    );
    const out = new Map<string, DailyBar[]>();
    for (const r of rows) {
      const list = out.get(r.symbol) ?? [];
      list.push(toBar(r));
      out.set(r.symbol, list);
    }
    return out;
  },

  async latestDate(db: Db): Promise<string | null> {
    const { rows } = await db.query<{ d: string | null }>('SELECT MAX(date) AS d FROM daily_prices');
    return rows[0]?.d ?? null;
  },
};

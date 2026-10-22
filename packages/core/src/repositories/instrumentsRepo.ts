import type { Db } from '../db/pool';

export interface InstrumentRow {
  symbol: string;
  yahoo_symbol: string;
  name: string;
  sector: string;
  active: boolean;
}

export const instrumentsRepo = {
  async upsertMany(db: Db, items: Array<{ symbol: string; name: string; sector: string }>): Promise<void> {
    if (items.length === 0) return;
    await db.query(
      `INSERT INTO instruments (symbol, yahoo_symbol, name, sector)
       SELECT s, s || '.NS', n, sec FROM unnest($1::text[], $2::text[], $3::text[]) AS t(s, n, sec)
       ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, sector = EXCLUDED.sector, active = true`,
      [items.map((i) => i.symbol), items.map((i) => i.name), items.map((i) => i.sector)],
    );
  },

  async findBySymbol(db: Db, symbol: string): Promise<InstrumentRow | null> {
    const { rows } = await db.query<InstrumentRow>('SELECT * FROM instruments WHERE symbol = $1', [symbol]);
    return rows[0] ?? null;
  },

  async search(db: Db, q: string, limit = 20): Promise<InstrumentRow[]> {
    const { rows } = await db.query<InstrumentRow>(
      `SELECT * FROM instruments
       WHERE active AND ($1 = '' OR symbol ILIKE $1 || '%' OR name ILIKE '%' || $1 || '%')
       ORDER BY (symbol ILIKE $1 || '%') DESC, symbol LIMIT $2`,
      [q, limit],
    );
    return rows;
  },

  async listActive(db: Db): Promise<InstrumentRow[]> {
    const { rows } = await db.query<InstrumentRow>('SELECT * FROM instruments WHERE active ORDER BY symbol');
    return rows;
  },
};

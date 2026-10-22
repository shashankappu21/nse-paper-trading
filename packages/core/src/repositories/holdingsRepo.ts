import type { Db } from '../db/pool';
import { toPaise, toSql } from '../money';
import { EMPTY_POSITION, type Position } from '../domain/portfolioMath';

interface HoldingRow {
  user_id: string;
  symbol: string;
  quantity: number;
  cost_basis: string;
  realised_pnl: string;
  name?: string;
}

export interface Holding extends Position {
  symbol: string;
  name: string;
}

const toPosition = (r: HoldingRow): Position => ({
  quantity: r.quantity,
  costBasis: toPaise(r.cost_basis),
  realisedPnl: toPaise(r.realised_pnl),
});

export const holdingsRepo = {
  /** Caller must hold the user lock when the result is used for a write. */
  async find(db: Db, userId: string, symbol: string): Promise<Position> {
    const { rows } = await db.query<HoldingRow>('SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2', [
      userId,
      symbol,
    ]);
    return rows[0] ? toPosition(rows[0]) : { ...EMPTY_POSITION };
  },

  async save(db: Db, userId: string, symbol: string, p: Position): Promise<void> {
    await db.query(
      `INSERT INTO holdings (user_id, symbol, quantity, cost_basis, realised_pnl)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, symbol) DO UPDATE SET
         quantity = EXCLUDED.quantity, cost_basis = EXCLUDED.cost_basis,
         realised_pnl = EXCLUDED.realised_pnl, updated_at = now()`,
      [userId, symbol, p.quantity, toSql(p.costBasis), toSql(p.realisedPnl)],
    );
  },

  async listForUser(db: Db, userId: string): Promise<Holding[]> {
    const { rows } = await db.query<HoldingRow>(
      `SELECT h.*, i.name FROM holdings h JOIN instruments i USING (symbol)
       WHERE h.user_id = $1 ORDER BY h.symbol`,
      [userId],
    );
    return rows.map((r) => ({ symbol: r.symbol, name: r.name ?? r.symbol, ...toPosition(r) }));
  },
};

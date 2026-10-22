import type { LedgerReason } from '@nse/shared';
import type { Db } from '../db/pool';
import { toPaise, toSql, type Paise } from '../money';

export interface LedgerRow {
  id: number;
  user_id: string;
  amount: string;
  reason: LedgerReason;
  order_id: string | null;
  created_at: Date;
}

export const ledgerRepo = {
  async insert(db: Db, e: { userId: string; amount: Paise; reason: LedgerReason; orderId?: string }): Promise<void> {
    await db.query('INSERT INTO cash_ledger (user_id, amount, reason, order_id) VALUES ($1, $2, $3, $4)', [
      e.userId,
      toSql(e.amount),
      e.reason,
      e.orderId ?? null,
    ]);
  },

  /** Available cash = sum of all ledger entries (HOLDs are negative, so blocked cash is excluded). */
  async balance(db: Db, userId: string): Promise<Paise> {
    const { rows } = await db.query<{ balance: string }>(
      'SELECT COALESCE(SUM(amount), 0) AS balance FROM cash_ledger WHERE user_id = $1',
      [userId],
    );
    return toPaise(rows[0]!.balance);
  },

  async list(db: Db, userId: string, limit = 100): Promise<LedgerRow[]> {
    const { rows } = await db.query<LedgerRow>(
      'SELECT * FROM cash_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
      [userId, limit],
    );
    return rows;
  },
};

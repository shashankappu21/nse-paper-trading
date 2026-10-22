import type { OrderSide, OrderStatus, OrderType, RejectReason } from '@nse/shared';
import type { Db } from '../db/pool';
import { toSql, type Paise } from '../money';

export interface OrderRow {
  id: string;
  user_id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limit_price: string | null;
  status: OrderStatus;
  fill_price: string | null;
  reject_reason: RejectReason | null;
  idempotency_key: string;
  request_hash: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  filled_at: Date | null;
}

export interface NewOrder {
  userId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: Paise | null;
  idempotencyKey: string;
  requestHash: string;
}

/** Statuses that still have a claim on the user's shares (for sell reservations). */
const IN_FLIGHT: OrderStatus[] = ['PLACED', 'VALIDATED', 'OPEN'];

export const ordersRepo = {
  /** Returns null when the (user, idempotency key) pair already exists. */
  async insert(db: Db, o: NewOrder): Promise<OrderRow | null> {
    const { rows } = await db.query<OrderRow>(
      `INSERT INTO orders (user_id, symbol, side, type, quantity, limit_price, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        o.userId,
        o.symbol,
        o.side,
        o.type,
        o.quantity,
        o.limitPrice === null ? null : toSql(o.limitPrice),
        o.idempotencyKey,
        o.requestHash,
      ],
    );
    return rows[0] ?? null;
  },

  async findByIdempotencyKey(db: Db, userId: string, key: string): Promise<OrderRow | null> {
    const { rows } = await db.query<OrderRow>('SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2', [
      userId,
      key,
    ]);
    return rows[0] ?? null;
  },

  async findById(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<OrderRow | null> {
    const { rows } = await db.query<OrderRow>(`SELECT * FROM orders WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [
      id,
    ]);
    return rows[0] ?? null;
  },

  async listForUser(db: Db, userId: string, opts: { status?: OrderStatus; limit?: number }): Promise<OrderRow[]> {
    const { rows } = await db.query<OrderRow>(
      `SELECT * FROM orders WHERE user_id = $1 AND ($2::order_status IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [userId, opts.status ?? null, opts.limit ?? 50],
    );
    return rows;
  },

  /**
   * Status change guarded by the expected current status (compare-and-set).
   * Returns null if the order was concurrently moved elsewhere.
   */
  async transition(
    db: Db,
    t: { id: string; from: OrderStatus; to: OrderStatus; fillPrice?: Paise; rejectReason?: RejectReason },
  ): Promise<OrderRow | null> {
    const { rows } = await db.query<OrderRow>(
      `UPDATE orders SET
         status = $3::order_status,
         fill_price = COALESCE($4::numeric, fill_price),
         reject_reason = COALESCE($5::text, reject_reason),
         filled_at = CASE WHEN $3::order_status = 'FILLED' THEN now() ELSE filled_at END,
         version = version + 1,
         updated_at = now()
       WHERE id = $1 AND status = $2
       RETURNING *`,
      [t.id, t.from, t.to, t.fillPrice === undefined ? null : toSql(t.fillPrice), t.rejectReason ?? null],
    );
    return rows[0] ?? null;
  },

  /** Quantity of this symbol already committed to the user's other in-flight sell orders. */
  async reservedSellQuantity(db: Db, userId: string, symbol: string, excludeOrderId: string): Promise<number> {
    const { rows } = await db.query<{ qty: number }>(
      `SELECT COALESCE(SUM(quantity), 0)::bigint AS qty FROM orders
       WHERE user_id = $1 AND symbol = $2 AND side = 'SELL' AND status = ANY($3::order_status[]) AND id <> $4`,
      [userId, symbol, IN_FLIGHT, excludeOrderId],
    );
    return rows[0]!.qty;
  },

  /** OPEN limit orders on a symbol placed before the given instant (served by the partial index). */
  async listOpenLimit(db: Db, symbol: string, placedBefore: Date): Promise<OrderRow[]> {
    const { rows } = await db.query<OrderRow>(
      `SELECT * FROM orders WHERE status = 'OPEN' AND type = 'LIMIT' AND symbol = $1 AND created_at < $2
       ORDER BY created_at`,
      [symbol, placedBefore],
    );
    return rows;
  },

  async symbolsWithOpenLimit(db: Db): Promise<string[]> {
    const { rows } = await db.query<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM orders WHERE status = 'OPEN' AND type = 'LIMIT'`,
    );
    return rows.map((r) => r.symbol);
  },

  /** Orders stuck in VALIDATED (e.g. API died between commit and enqueue). */
  async listStaleValidated(db: Db, olderThan: Date, limit = 100): Promise<OrderRow[]> {
    const { rows } = await db.query<OrderRow>(
      `SELECT * FROM orders WHERE status = 'VALIDATED' AND updated_at < $1 ORDER BY updated_at LIMIT $2`,
      [olderThan, limit],
    );
    return rows;
  },
};

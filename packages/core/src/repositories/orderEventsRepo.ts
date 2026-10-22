import type { OrderStatus } from '@nse/shared';
import type { Db } from '../db/pool';

export interface OrderEventRow {
  id: number;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  payload: Record<string, unknown>;
  request_id: string | null;
  created_at: Date;
}

export const orderEventsRepo = {
  async insert(
    db: Db,
    e: { orderId: string; from: OrderStatus | null; to: OrderStatus; payload?: Record<string, unknown>; requestId?: string },
  ): Promise<void> {
    await db.query(
      'INSERT INTO order_events (order_id, from_status, to_status, payload, request_id) VALUES ($1, $2, $3, $4, $5)',
      [e.orderId, e.from, e.to, JSON.stringify(e.payload ?? {}), e.requestId ?? null],
    );
  },

  async listForOrder(db: Db, orderId: string): Promise<OrderEventRow[]> {
    const { rows } = await db.query<OrderEventRow>('SELECT * FROM order_events WHERE order_id = $1 ORDER BY id', [orderId]);
    return rows;
  },
};

import type { OrderStatus, RejectReason } from '@nse/shared';
import type { Db } from '../db/pool';
import { assertTransition } from '../domain/orderStateMachine';
import { Errors } from '../errors';
import type { Paise } from '../money';
import { ordersRepo, type OrderRow } from '../repositories/ordersRepo';
import { orderEventsRepo } from '../repositories/orderEventsRepo';

/**
 * The only way an order changes status: checks the state machine, applies a
 * compare-and-set update and appends an order_event, all on the caller's transaction.
 */
export async function transitionOrder(
  db: Db,
  order: OrderRow,
  to: OrderStatus,
  opts: { requestId?: string; fillPrice?: Paise; rejectReason?: RejectReason; payload?: Record<string, unknown> } = {},
): Promise<OrderRow> {
  assertTransition(order.status, to);
  const updated = await ordersRepo.transition(db, {
    id: order.id,
    from: order.status,
    to,
    fillPrice: opts.fillPrice,
    rejectReason: opts.rejectReason,
  });
  if (!updated) throw Errors.conflict(`Order ${order.id} changed concurrently`);
  const payload = { ...opts.payload };
  if (opts.rejectReason) payload.reason = opts.rejectReason;
  if (opts.fillPrice !== undefined) payload.fillPrice = opts.fillPrice / 100;
  await orderEventsRepo.insert(db, { orderId: order.id, from: order.status, to, payload, requestId: opts.requestId });
  return updated;
}

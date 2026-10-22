import type { OrderDto, OrderEventDto, UserDto } from '@nse/shared';
import type { OrderRow } from '../repositories/ordersRepo';
import type { OrderEventRow } from '../repositories/orderEventsRepo';
import type { UserRow } from '../repositories/usersRepo';

export const userToDto = (u: UserRow): UserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
  createdAt: u.created_at.toISOString(),
});

export const orderToDto = (o: OrderRow): OrderDto => ({
  id: o.id,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  quantity: o.quantity,
  limitPrice: o.limit_price === null ? null : Number(o.limit_price),
  status: o.status,
  fillPrice: o.fill_price === null ? null : Number(o.fill_price),
  rejectReason: o.reject_reason,
  createdAt: o.created_at.toISOString(),
  updatedAt: o.updated_at.toISOString(),
});

export const eventToDto = (e: OrderEventRow): OrderEventDto => ({
  id: String(e.id),
  fromStatus: e.from_status,
  toStatus: e.to_status,
  payload: e.payload,
  requestId: e.request_id,
  createdAt: e.created_at.toISOString(),
});

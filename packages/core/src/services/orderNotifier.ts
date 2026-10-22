import type { Redis } from 'ioredis';
import type { OrderDto } from '@nse/shared';
import { ORDERS_CHANNEL } from '../market/types';
import type { OrderListener } from './executionService';

export interface OrderUpdateMessage {
  userId: string;
  order: OrderDto;
}

/** Fan-out of order status changes via Redis pub/sub; the API pushes them to the user's sockets. */
export function redisOrderNotifier(redis: Redis): OrderListener {
  return async (userId, order) => {
    const msg: OrderUpdateMessage = { userId, order };
    await redis.publish(ORDERS_CHANNEL, JSON.stringify(msg));
  };
}

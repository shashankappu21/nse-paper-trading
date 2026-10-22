import { createHash } from 'node:crypto';
import type { OrderDto, OrderStatus, OrderWithEventsDto, PlaceOrderInput, QuoteDto } from '@nse/shared';
import { withTransaction, type Db, type Pool } from '../db/pool';
import { checkBuyingPower, checkSellableQuantity, orderValue, type CheckResult } from '../domain/preTradeChecks';
import { AppError, Errors } from '../errors';
import { getLogger } from '../logger';
import type { QuoteSource } from '../market/types';
import { toPaise } from '../money';
import { holdingsRepo } from '../repositories/holdingsRepo';
import { instrumentsRepo } from '../repositories/instrumentsRepo';
import { ledgerRepo } from '../repositories/ledgerRepo';
import { orderEventsRepo } from '../repositories/orderEventsRepo';
import { ordersRepo, type OrderRow } from '../repositories/ordersRepo';
import { usersRepo } from '../repositories/usersRepo';
import type { OrderDispatcher } from './dispatcher';
import { eventToDto, orderToDto } from './mappers';
import { transitionOrder } from './orderTransitions';

export interface PlaceOrderCommand {
  userId: string;
  input: PlaceOrderInput;
  idempotencyKey: string;
  requestId?: string;
}

export interface PlaceOrderResult {
  order: OrderDto;
  /** true when this Idempotency-Key was seen before and the original order is returned. */
  replayed: boolean;
}

/** Stable fingerprint of the request body, to detect a key reused with different content. */
function requestHash(input: PlaceOrderInput): string {
  const canonical = JSON.stringify([input.symbol, input.side, input.type, input.quantity, input.limitPrice ?? null]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The API side of order handling: accept, validate (pre-trade checks), persist and hand
 * off to execution. It never fills orders itself.
 */
export class OrderService {
  constructor(
    private readonly pool: Pool,
    private readonly quotes: QuoteSource,
    private readonly dispatcher: OrderDispatcher,
  ) {}

  async placeOrder(cmd: PlaceOrderCommand): Promise<PlaceOrderResult> {
    const { userId, input, idempotencyKey, requestId } = cmd;
    const hash = requestHash(input);

    // Fast path for retries, without touching the market data provider.
    const prior = await ordersRepo.findByIdempotencyKey(this.pool, userId, idempotencyKey);
    if (prior) return this.replay(prior, hash, requestId);

    const instrument = await instrumentsRepo.findBySymbol(this.pool, input.symbol);
    if (!instrument) throw Errors.notFound(`Instrument ${input.symbol}`);

    // Fetch the price before opening the transaction so no lock is held over a network call.
    const quote = input.type === 'MARKET' ? await this.tryQuote(input.symbol) : null;

    const outcome = await withTransaction(this.pool, async (tx) => {
      await usersRepo.lock(tx, userId);
      const inserted = await ordersRepo.insert(tx, {
        userId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        quantity: input.quantity,
        limitPrice: input.limitPrice === undefined ? null : toPaise(input.limitPrice),
        idempotencyKey,
        requestHash: hash,
      });
      if (!inserted) return { replayOf: await ordersRepo.findByIdempotencyKey(tx, userId, idempotencyKey) };

      await orderEventsRepo.insert(tx, {
        orderId: inserted.id,
        from: null,
        to: 'PLACED',
        payload: { ...input },
        requestId,
      });

      // Instruments that left the index are exit-only: users may still sell what they hold.
      if (!instrument.active && input.side === 'BUY') {
        return {
          order: await transitionOrder(tx, inserted, 'REJECTED', {
            requestId,
            rejectReason: 'INSTRUMENT_NOT_TRADABLE',
            payload: { message: `${input.symbol} is no longer in the tradable universe; only sells are allowed` },
          }),
        };
      }
      const check = await this.preTradeCheck(tx, inserted, quote);
      if (!check.ok) {
        return {
          order: await transitionOrder(tx, inserted, 'REJECTED', {
            requestId,
            rejectReason: check.reason,
            payload: { message: check.message },
          }),
        };
      }
      return {
        order: await transitionOrder(tx, inserted, 'VALIDATED', {
          requestId,
          payload: quote ? { referencePrice: quote.price } : {},
        }),
      };
    });

    if ('replayOf' in outcome) {
      if (!outcome.replayOf) throw Errors.conflict('Idempotency key conflict, please retry');
      return this.replay(outcome.replayOf, hash, requestId);
    }

    const order = outcome.order;
    getLogger().info({ orderId: order.id, status: order.status, symbol: order.symbol }, 'order placed');
    if (order.status === 'VALIDATED') await this.dispatch(order, requestId);
    return { order: orderToDto((await ordersRepo.findById(this.pool, order.id)) ?? order), replayed: false };
  }

  async cancelOrder(userId: string, orderId: string, requestId?: string): Promise<OrderDto> {
    const updated = await withTransaction(this.pool, async (tx) => {
      // Lock order: user, then order (same as execution) to avoid deadlocks.
      await usersRepo.lock(tx, userId);
      const order = await ordersRepo.findById(tx, orderId, { forUpdate: true });
      if (!order || order.user_id !== userId) throw Errors.notFound('Order');
      const cancelled = await transitionOrder(tx, order, 'CANCELLED', { requestId, payload: { by: 'user' } });
      if (order.side === 'BUY' && order.type === 'LIMIT') {
        const blocked = orderValue(order.quantity, toPaise(order.limit_price!));
        await ledgerRepo.insert(tx, { userId, amount: blocked, reason: 'RELEASE', orderId: order.id });
      }
      return cancelled;
    });
    getLogger().info({ orderId }, 'order cancelled');
    return orderToDto(updated);
  }

  async getOrder(userId: string, orderId: string): Promise<OrderWithEventsDto> {
    const order = await ordersRepo.findById(this.pool, orderId);
    if (!order || order.user_id !== userId) throw Errors.notFound('Order');
    const events = await orderEventsRepo.listForOrder(this.pool, orderId);
    return { ...orderToDto(order), events: events.map(eventToDto) };
  }

  async listOrders(userId: string, opts: { status?: OrderStatus; limit?: number }): Promise<OrderDto[]> {
    return (await ordersRepo.listForUser(this.pool, userId, opts)).map(orderToDto);
  }

  /** Re-dispatch orders that were validated but never reached execution. */
  async redispatchStale(olderThanMs: number): Promise<number> {
    const stale = await ordersRepo.listStaleValidated(this.pool, new Date(Date.now() - olderThanMs));
    // A new job id per sweep: the original job may still sit in BullMQ's failed set, which would dedupe it.
    const suffix = `r${Math.floor(Date.now() / 60_000)}`;
    for (const order of stale) await this.dispatch(order, `reconcile-${order.id}`, suffix);
    return stale.length;
  }

  private async replay(prior: OrderRow, hash: string, requestId?: string): Promise<PlaceOrderResult> {
    if (prior.request_hash !== hash) throw Errors.idempotencyKeyReused();
    // If the first attempt committed but never reached the queue, this retry recovers it.
    if (prior.status === 'VALIDATED') await this.dispatch(prior, requestId);
    const fresh = (await ordersRepo.findById(this.pool, prior.id)) ?? prior;
    return { order: orderToDto(fresh), replayed: true };
  }

  private async preTradeCheck(tx: Db, order: OrderRow, quote: QuoteDto | null): Promise<CheckResult> {
    const price = order.type === 'LIMIT' ? toPaise(order.limit_price!) : quote ? toPaise(quote.price) : null;
    if (price === null) {
      return { ok: false, reason: 'PRICE_UNAVAILABLE', message: `No market price for ${order.symbol}` };
    }
    if (order.side === 'BUY') {
      return checkBuyingPower(await ledgerRepo.balance(tx, order.user_id), orderValue(order.quantity, price));
    }
    const position = await holdingsRepo.find(tx, order.user_id, order.symbol);
    const reserved = await ordersRepo.reservedSellQuantity(tx, order.user_id, order.symbol, order.id);
    return checkSellableQuantity(position.quantity, reserved, order.quantity);
  }

  private async dispatch(order: OrderRow, requestId?: string, jobIdSuffix?: string): Promise<void> {
    try {
      await this.dispatcher.dispatch({ orderId: order.id, requestId, jobIdSuffix });
    } catch (err) {
      // The order is safely persisted as VALIDATED; the reconciler will pick it up.
      getLogger().error({ err, orderId: order.id }, 'failed to dispatch order');
    }
  }

  private async tryQuote(symbol: string): Promise<QuoteDto | null> {
    try {
      return await this.quotes.getQuote(symbol);
    } catch (err) {
      if (err instanceof AppError && err.code === 'PRICE_UNAVAILABLE') return null;
      throw err;
    }
  }
}

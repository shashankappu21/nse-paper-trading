import type { OrderDto, QuoteDto } from '@nse/shared';
import { withTransaction, type Db, type Pool } from '../db/pool';
import { applyBuy, applySell } from '../domain/portfolioMath';
import { checkBuyingPower, checkSellableQuantity, orderValue } from '../domain/preTradeChecks';
import { AppError } from '../errors';
import { getLogger } from '../logger';
import type { QuoteSource } from '../market/types';
import { toPaise, type Paise } from '../money';
import { holdingsRepo } from '../repositories/holdingsRepo';
import { ledgerRepo } from '../repositories/ledgerRepo';
import { ordersRepo, type OrderRow } from '../repositories/ordersRepo';
import { pricesRepo } from '../repositories/pricesRepo';
import { usersRepo } from '../repositories/usersRepo';
import { orderToDto } from './mappers';
import { transitionOrder } from './orderTransitions';

/** Called after a transaction commits so other systems (WebSocket push) can react. */
export type OrderListener = (userId: string, order: OrderDto) => void | Promise<void>;

export interface SweepResult {
  date: string;
  examined: number;
  filled: number;
  rejected: number;
}

/**
 * The execution side of the broker. Takes VALIDATED orders to OPEN and fills them.
 * Every fill updates the order, holdings and cash ledger in ONE transaction, under a
 * per-user row lock, and re-checks funds/holdings at fill time because they may have
 * changed since the API validated the order.
 */
export class ExecutionService {
  constructor(
    private readonly pool: Pool,
    private readonly quotes: QuoteSource,
    private readonly onOrderUpdate?: OrderListener,
  ) {}

  /** Idempotent: does nothing unless the order is still VALIDATED (safe for queue retries). */
  async executeOrder(orderId: string, requestId?: string): Promise<OrderRow | null> {
    const log = getLogger().child({ orderId });
    const snapshot = await ordersRepo.findById(this.pool, orderId);
    if (!snapshot || snapshot.status !== 'VALIDATED') {
      log.debug({ status: snapshot?.status }, 'order not executable, skipping');
      return snapshot;
    }

    // Network call happens before taking any locks.
    let quote: QuoteDto | null = null;
    if (snapshot.type === 'MARKET') quote = await this.tryQuote(snapshot.symbol);

    const result = await withTransaction(this.pool, async (tx) => {
      await usersRepo.lock(tx, snapshot.user_id);
      const order = await ordersRepo.findById(tx, orderId, { forUpdate: true });
      if (!order || order.status !== 'VALIDATED') return order;

      if (order.type === 'LIMIT') return this.openLimitOrder(tx, order, requestId);

      if (!quote) {
        return transitionOrder(tx, order, 'REJECTED', { requestId, rejectReason: 'PRICE_UNAVAILABLE' });
      }
      const open = await transitionOrder(tx, order, 'OPEN', { requestId });
      return this.fill(tx, open, toPaise(quote.price), requestId, { source: 'MARKET', quoteAsOf: quote.asOf });
    });

    if (result) {
      log.info({ status: result.status, fillPrice: result.fill_price }, 'order executed');
      await this.notify(result);
    }
    return result;
  }

  /**
   * End-of-day job: fill OPEN limit orders whose limit was crossed by `date`'s candle.
   * BUY fills if low <= limit, SELL if high >= limit, both at the limit price.
   * Only orders placed before that session's close (15:30 IST) are eligible.
   */
  async sweepLimitOrders(date: string): Promise<SweepResult> {
    const log = getLogger().child({ job: 'limit-sweep', date });
    const sessionClose = new Date(`${date}T15:30:00+05:30`);
    const result: SweepResult = { date, examined: 0, filled: 0, rejected: 0 };
    const requestId = `eod-${date}`;

    for (const symbol of await ordersRepo.symbolsWithOpenLimit(this.pool)) {
      const bar = await pricesRepo.findBar(this.pool, symbol, date);
      if (!bar) continue;
      for (const candidate of await ordersRepo.listOpenLimit(this.pool, symbol, sessionClose)) {
        result.examined += 1;
        const limit = Number(candidate.limit_price);
        const crossed = candidate.side === 'BUY' ? bar.low <= limit : bar.high >= limit;
        if (!crossed) continue;
        try {
          const done = await withTransaction(this.pool, async (tx) => {
            await usersRepo.lock(tx, candidate.user_id);
            const order = await ordersRepo.findById(tx, candidate.id, { forUpdate: true });
            if (!order || order.status !== 'OPEN') return null; // cancelled meanwhile
            return this.fill(tx, order, toPaise(limit), requestId, { source: 'EOD_SWEEP', bar });
          });
          if (done?.status === 'FILLED') result.filled += 1;
          if (done?.status === 'REJECTED') result.rejected += 1;
          if (done) await this.notify(done);
        } catch (err) {
          log.error({ err, orderId: candidate.id }, 'failed to fill limit order');
        }
      }
    }
    log.info(result, 'limit order sweep complete');
    return result;
  }

  private async openLimitOrder(tx: Db, order: OrderRow, requestId?: string): Promise<OrderRow> {
    if (order.side === 'BUY') {
      const required = orderValue(order.quantity, toPaise(order.limit_price!));
      const check = checkBuyingPower(await ledgerRepo.balance(tx, order.user_id), required);
      if (!check.ok) return transitionOrder(tx, order, 'REJECTED', { requestId, rejectReason: check.reason, payload: { message: check.message } });
      // Block the cash so it can't be spent twice while the order is open.
      await ledgerRepo.insert(tx, { userId: order.user_id, amount: -required, reason: 'HOLD', orderId: order.id });
      return transitionOrder(tx, order, 'OPEN', { requestId, payload: { blocked: required / 100 } });
    }
    const check = await this.sellCheck(tx, order);
    if (!check.ok) return transitionOrder(tx, order, 'REJECTED', { requestId, rejectReason: check.reason, payload: { message: check.message } });
    return transitionOrder(tx, order, 'OPEN', { requestId });
  }

  /** Fill an OPEN order at `price`. Caller holds the user lock inside `tx`. */
  private async fill(
    tx: Db,
    order: OrderRow,
    price: Paise,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<OrderRow> {
    const value = orderValue(order.quantity, price);
    const position = await holdingsRepo.find(tx, order.user_id, order.symbol);

    if (order.side === 'BUY') {
      if (order.type === 'LIMIT') {
        // Release the block first; the actual debit follows.
        const blocked = orderValue(order.quantity, toPaise(order.limit_price!));
        await ledgerRepo.insert(tx, { userId: order.user_id, amount: blocked, reason: 'RELEASE', orderId: order.id });
      }
      const check = checkBuyingPower(await ledgerRepo.balance(tx, order.user_id), value);
      if (!check.ok) return transitionOrder(tx, order, 'REJECTED', { requestId, rejectReason: check.reason, payload: { message: check.message } });
      await ledgerRepo.insert(tx, { userId: order.user_id, amount: -value, reason: 'BUY', orderId: order.id });
      await holdingsRepo.save(tx, order.user_id, order.symbol, applyBuy(position, order.quantity, price));
      return transitionOrder(tx, order, 'FILLED', { requestId, fillPrice: price, payload });
    }

    // SELL: this order's own shares are reserved for it, so check against everything else.
    const check = await this.sellCheck(tx, order);
    if (!check.ok) return transitionOrder(tx, order, 'REJECTED', { requestId, rejectReason: check.reason, payload: { message: check.message } });
    const { position: next, realised } = applySell(position, order.quantity, price);
    await ledgerRepo.insert(tx, { userId: order.user_id, amount: value, reason: 'SELL', orderId: order.id });
    await holdingsRepo.save(tx, order.user_id, order.symbol, next);
    return transitionOrder(tx, order, 'FILLED', {
      requestId,
      fillPrice: price,
      payload: { ...payload, realisedPnl: realised / 100 },
    });
  }

  private async sellCheck(tx: Db, order: OrderRow) {
    const position = await holdingsRepo.find(tx, order.user_id, order.symbol);
    const reserved = await ordersRepo.reservedSellQuantity(tx, order.user_id, order.symbol, order.id);
    return checkSellableQuantity(position.quantity, reserved, order.quantity);
  }

  private async tryQuote(symbol: string): Promise<QuoteDto | null> {
    try {
      return await this.quotes.getQuote(symbol);
    } catch (err) {
      if (err instanceof AppError && err.code === 'PRICE_UNAVAILABLE') return null;
      throw err;
    }
  }

  private async notify(order: OrderRow): Promise<void> {
    if (!this.onOrderUpdate) return;
    try {
      await this.onOrderUpdate(order.user_id, orderToDto(order));
    } catch (err) {
      getLogger().warn({ err, orderId: order.id }, 'order listener failed');
    }
  }
}

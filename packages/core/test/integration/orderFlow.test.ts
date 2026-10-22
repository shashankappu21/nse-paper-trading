import {
  AuthService,
  ExecutionService,
  OrderService,
  PortfolioService,
  SyncDispatcher,
  pricesRepo,
  AppError,
  type Pool,
} from '../../src';
import { StubQuotes, config, idemKey, resetDb, testPool, uniqueEmail } from '../helpers';

/** IST calendar date offset by `days` from today, as YYYY-MM-DD. */
function istDate(days: number): string {
  const d = new Date(Date.now() + 5.5 * 3600_000 + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe('order flow (integration, real Postgres)', () => {
  let pool: Pool;
  let quotes: StubQuotes;
  let auth: AuthService;
  let orders: OrderService;
  let execution: ExecutionService;
  let portfolio: PortfolioService;
  let userId: string;

  beforeAll(() => {
    pool = testPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDb(pool);
    quotes = new StubQuotes().set('RELIANCE', 1400).set('TCS', 3000).set('INFY', 1500);
    auth = new AuthService(pool, config);
    execution = new ExecutionService(pool, quotes);
    orders = new OrderService(pool, quotes, new SyncDispatcher(execution));
    portfolio = new PortfolioService(pool, quotes);
    const res = await auth.register({ email: uniqueEmail(), password: 'password123', name: 'Test' });
    userId = res.user.id;
  });

  const place = (input: Parameters<OrderService['placeOrder']>[0]['input'], key = idemKey(), requestId = 'req-test') =>
    orders.placeOrder({ userId, input, idempotencyKey: key, requestId });

  const cash = async () => (await portfolio.getPortfolio(userId)).cash;

  it('new users start with ₹10,00,000 credited through the ledger', async () => {
    expect(await cash()).toBe(1_000_000);
    const ledger = await portfolio.getLedger(userId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 1_000_000, reason: 'DEPOSIT' });
  });

  describe('market orders', () => {
    it('a market buy fills at the latest price and updates order, holdings and ledger together', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 10 });
      expect(order.status).toBe('FILLED');
      expect(order.fillPrice).toBe(1400);
      expect(await cash()).toBe(1_000_000 - 14_000);

      const p = await portfolio.getPortfolio(userId);
      expect(p.holdings).toEqual([expect.objectContaining({ symbol: 'RELIANCE', quantity: 10, avgPrice: 1400 })]);

      const detail = await orders.getOrder(userId, order.id);
      expect(detail.events.map((e) => e.toStatus)).toEqual(['PLACED', 'VALIDATED', 'OPEN', 'FILLED']);
      expect(detail.events.every((e) => e.requestId === 'req-test')).toBe(true);
    });

    it('rejects a buy with INSUFFICIENT_FUNDS and leaves cash untouched', async () => {
      const { order } = await place({ symbol: 'TCS', side: 'BUY', type: 'MARKET', quantity: 400 }); // ₹12L
      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('INSUFFICIENT_FUNDS');
      expect(await cash()).toBe(1_000_000);
      expect((await portfolio.getPortfolio(userId)).holdings).toHaveLength(0);
    });

    it('rejects a sell with INSUFFICIENT_HOLDINGS when the user has none', async () => {
      const { order } = await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 1 });
      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('INSUFFICIENT_HOLDINGS');
    });

    it('rejects a sell larger than the position', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 5 });
      const { order } = await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 6 });
      expect(order.rejectReason).toBe('INSUFFICIENT_HOLDINGS');
    });

    it('a market sell credits proceeds and realises P&L', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 10 }); // 15,000
      quotes.set('INFY', 1600);
      const { order } = await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 4 });
      expect(order.status).toBe('FILLED');
      expect(order.fillPrice).toBe(1600);

      const p = await portfolio.getPortfolio(userId);
      expect(p.cash).toBe(1_000_000 - 15_000 + 6_400);
      expect(p.realisedPnl).toBe(400);
      const infy = p.holdings.find((h) => h.symbol === 'INFY')!;
      expect(infy.quantity).toBe(6);
      expect(infy.avgPrice).toBe(1500);
      expect(infy.unrealisedPnl).toBe(600); // (1600-1500)*6
    });

    it('rejects with PRICE_UNAVAILABLE when there is no quote', async () => {
      const { order } = await place({ symbol: 'BSE', side: 'BUY', type: 'MARKET', quantity: 1 });
      expect(order.status).toBe('REJECTED');
      expect(order.rejectReason).toBe('PRICE_UNAVAILABLE');
    });

    it('concurrent buys can never overspend: the second is rejected at fill time', async () => {
      quotes.set('TCS', 3000);
      const results = await Promise.all([
        place({ symbol: 'TCS', side: 'BUY', type: 'MARKET', quantity: 200 }), // ₹6L each
        place({ symbol: 'TCS', side: 'BUY', type: 'MARKET', quantity: 200 }),
      ]);
      const statuses = results.map((r) => r.order.status).sort();
      expect(statuses).toEqual(['FILLED', 'REJECTED']);
      expect(await cash()).toBe(400_000);
    });
  });

  describe('index changes', () => {
    // Simulates a stock leaving the NIFTY 50 (e.g. WIPRO -> BSE in Sep 2026) while users still hold it.
    afterEach(() => pool.query(`UPDATE instruments SET active = true WHERE symbol = 'INFY'`));

    it('an instrument that left the universe is exit-only: buys rejected, sells allowed', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 4 });
      await pool.query(`UPDATE instruments SET active = false WHERE symbol = 'INFY'`);

      const buy = await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 1 });
      expect(buy.order).toMatchObject({ status: 'REJECTED', rejectReason: 'INSTRUMENT_NOT_TRADABLE' });

      const sell = await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 4 });
      expect(sell.order.status).toBe('FILLED');
    });
  });

  describe('limit orders', () => {
    it('a limit buy stays OPEN and blocks cash until the EOD sweep', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: 1350 });
      expect(order.status).toBe('OPEN');
      expect(await cash()).toBe(1_000_000 - 13_500); // HOLD entry
    });

    it('the sweep fills a buy at the limit price when the day low crosses it, releasing the hold', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: 1350 });
      const date = istDate(1);
      await pricesRepo.upsertMany(pool, [{ symbol: 'RELIANCE', date, open: 1390, high: 1400, low: 1340, close: 1380, volume: 1 }]);

      const result = await execution.sweepLimitOrders(date);
      expect(result.filled).toBe(1);

      const filled = await orders.getOrder(userId, order.id);
      expect(filled.status).toBe('FILLED');
      expect(filled.fillPrice).toBe(1350);
      expect(await cash()).toBe(1_000_000 - 13_500);
      const reasons = (await portfolio.getLedger(userId)).map((l) => l.reason).sort();
      expect(reasons).toEqual(['BUY', 'DEPOSIT', 'HOLD', 'RELEASE']);
    });

    it('the sweep leaves an order OPEN when the limit was not crossed', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: 1300 });
      const date = istDate(1);
      await pricesRepo.upsertMany(pool, [{ symbol: 'RELIANCE', date, open: 1390, high: 1400, low: 1340, close: 1380, volume: 1 }]);
      expect((await execution.sweepLimitOrders(date)).filled).toBe(0);
      expect((await orders.getOrder(userId, order.id)).status).toBe('OPEN');
    });

    it('a limit sell fills when the day high reaches the limit', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 10 });
      const { order } = await place({ symbol: 'INFY', side: 'SELL', type: 'LIMIT', quantity: 10, limitPrice: 1550 });
      expect(order.status).toBe('OPEN');
      const date = istDate(1);
      await pricesRepo.upsertMany(pool, [{ symbol: 'INFY', date, open: 1500, high: 1560, low: 1490, close: 1520, volume: 1 }]);
      await execution.sweepLimitOrders(date);
      const filled = await orders.getOrder(userId, order.id);
      expect(filled.status).toBe('FILLED');
      expect(filled.fillPrice).toBe(1550);
      expect((await portfolio.getPortfolio(userId)).realisedPnl).toBe(500);
    });

    it('does not fill against a candle whose session closed before the order was placed', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 1350 });
      const date = istDate(-1);
      await pricesRepo.upsertMany(pool, [{ symbol: 'RELIANCE', date, open: 1300, high: 1300, low: 1300, close: 1300, volume: 1 }]);
      await execution.sweepLimitOrders(date);
      expect((await orders.getOrder(userId, order.id)).status).toBe('OPEN');
    });

    it('open limit sells reserve quantity so the same shares cannot be sold twice', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 10 });
      await place({ symbol: 'INFY', side: 'SELL', type: 'LIMIT', quantity: 8, limitPrice: 2000 });
      const { order } = await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 3 });
      expect(order.rejectReason).toBe('INSUFFICIENT_HOLDINGS');
    });

    it('blocked cash counts against buying power', async () => {
      await place({ symbol: 'TCS', side: 'BUY', type: 'LIMIT', quantity: 300, limitPrice: 3000 }); // blocks ₹9L
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 100 }); // ₹1.4L
      expect(order.rejectReason).toBe('INSUFFICIENT_FUNDS');
    });
  });

  describe('cancellation', () => {
    it('cancelling an OPEN limit buy releases the blocked cash', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: 1350 });
      const cancelled = await orders.cancelOrder(userId, order.id, 'req-cancel');
      expect(cancelled.status).toBe('CANCELLED');
      expect(await cash()).toBe(1_000_000);
      const detail = await orders.getOrder(userId, order.id);
      expect(detail.events.at(-1)).toMatchObject({ fromStatus: 'OPEN', toStatus: 'CANCELLED', requestId: 'req-cancel' });
    });

    it('cancelling an OPEN limit sell frees the reserved quantity', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 5 });
      const { order } = await place({ symbol: 'INFY', side: 'SELL', type: 'LIMIT', quantity: 5, limitPrice: 2000 });
      await orders.cancelOrder(userId, order.id, 'r');
      const { order: sell } = await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 5 });
      expect(sell.status).toBe('FILLED');
    });

    it('cancelling a FILLED order is an invalid state transition', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 1 });
      await expect(orders.cancelOrder(userId, order.id, 'r')).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
    });

    it('cancelling twice fails the second time', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 1000 });
      await orders.cancelOrder(userId, order.id, 'r');
      await expect(orders.cancelOrder(userId, order.id, 'r')).rejects.toBeInstanceOf(AppError);
      expect(await cash()).toBe(1_000_000); // released exactly once
    });

    it("users cannot see or cancel someone else's order", async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 1000 });
      const other = await auth.register({ email: uniqueEmail(), password: 'password123', name: 'Other' });
      await expect(orders.cancelOrder(other.user.id, order.id, 'r')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(orders.getOrder(other.user.id, order.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('idempotency', () => {
    it('replaying the same Idempotency-Key returns the original order and fills only once', async () => {
      const key = idemKey();
      const input = { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 10 } as const;
      const first = await place(input, key);
      const second = await place(input, key);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.order.id).toBe(first.order.id);
      expect(await cash()).toBe(1_000_000 - 14_000);
      expect(await orders.listOrders(userId, {})).toHaveLength(1);
    });

    it('concurrent requests with the same key create exactly one order', async () => {
      const key = idemKey();
      const input = { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 1 } as const;
      const results = await Promise.all(Array.from({ length: 5 }, () => place(input, key)));
      expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await orders.listOrders(userId, {})).toHaveLength(1);
      expect(await cash()).toBe(1_000_000 - 1_400);
    });

    it('reusing a key with a different body is rejected with IDEMPOTENCY_KEY_REUSED', async () => {
      const key = idemKey();
      await place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 1 }, key);
      await expect(place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 2 }, key)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    it('the same key from different users creates independent orders', async () => {
      const key = idemKey();
      const input = { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 1 } as const;
      const other = await auth.register({ email: uniqueEmail(), password: 'password123', name: 'Other' });
      const a = await place(input, key);
      const b = await orders.placeOrder({ userId: other.user.id, input, idempotencyKey: key, requestId: 'r' });
      expect(a.order.id).not.toBe(b.order.id);
    });
  });

  describe('execution robustness', () => {
    it('re-executing an already processed order is a no-op (safe for queue retries)', async () => {
      const { order } = await place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 1 });
      await execution.executeOrder(order.id, 'retry');
      await execution.executeOrder(order.id, 'retry');
      expect(await cash()).toBe(1_000_000 - 1_400);
    });
  });

  describe('portfolio P&L', () => {
    it('aggregates invested value, current value, realised and unrealised P&L', async () => {
      await place({ symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 10 }); // 14,000
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 10 }); // 15,000
      quotes.set('INFY', 1450);
      await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 2 }); // realise -100
      quotes.set('RELIANCE', 1500).set('INFY', 1400);

      const p = await portfolio.getPortfolio(userId);
      expect(p.investedValue).toBe(14_000 + 12_000);
      expect(p.currentValue).toBe(15_000 + 11_200);
      expect(p.unrealisedPnl).toBe(1_000 - 800);
      expect(p.realisedPnl).toBe(-100);
      expect(p.cash).toBe(1_000_000 - 14_000 - 15_000 + 2_900);
      expect(p.totalValue).toBe(p.cash + p.currentValue);
    });

    it('fully closed positions are hidden from holdings but their realised P&L still counts', async () => {
      await place({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 2 });
      quotes.set('INFY', 1600);
      await place({ symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 2 });
      const p = await portfolio.getPortfolio(userId);
      expect(p.holdings).toHaveLength(0);
      expect(p.realisedPnl).toBe(200);
    });
  });
});

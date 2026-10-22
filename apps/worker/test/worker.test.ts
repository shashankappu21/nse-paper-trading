import { randomUUID } from 'node:crypto';
import { QueueEvents, type Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { QuoteDto } from '@nse/shared';
import {
  AuthService,
  EodService,
  ExecutionService,
  MarketDataService,
  ORDERS_CHANNEL,
  OrderService,
  PortfolioService,
  PriceIngestService,
  QueueDispatcher,
  SCHEDULED_QUEUE,
  bullConnection,
  createOrderQueue,
  createPool,
  createScheduledQueue,
  istDateString,
  loadConfig,
  redisOrderNotifier,
  type DailyBar,
  type EodJobData,
  type ExecuteOrderJob,
  type OrderDispatcher,
  type Pool,
  type PriceProvider,
} from '@nse/core';
import { createWorkers } from '../src/workers';

const config = loadConfig();

/** Controllable market: fixed quotes and whatever daily bars the test sets. */
class TestProvider implements PriceProvider {
  readonly name = 'test';
  prices: Record<string, number> = { RELIANCE: 1400, TCS: 3000 };
  bars: DailyBar[] = [];
  async getQuotes(symbols: string[]): Promise<QuoteDto[]> {
    return symbols
      .filter((s) => this.prices[s] !== undefined)
      .map((s) => ({ symbol: s, price: this.prices[s]!, previousClose: this.prices[s]!, change: 0, changePercent: 0, asOf: new Date().toISOString() }));
  }
  async getDailyHistory(symbol: string): Promise<DailyBar[]> {
    return this.bars.filter((b) => b.symbol === symbol);
  }
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('execution worker (BullMQ, integration)', () => {
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  let pool: Pool;
  let redis: Redis;
  let provider: TestProvider;
  let orderQueue: Queue<ExecuteOrderJob>;
  let scheduledQueue: Queue<EodJobData>;
  let scheduledEvents: QueueEvents;
  let workers: ReturnType<typeof createWorkers>;
  let orders: OrderService;
  let portfolio: PortfolioService;
  let auth: AuthService;
  let userId: string;

  beforeAll(async () => {
    pool = createPool(config.DATABASE_URL, 5);
    redis = new Redis(config.REDIS_URL);
    provider = new TestProvider();
    const marketData = new MarketDataService(redis, provider, 1);
    const execution = new ExecutionService(pool, marketData, redisOrderNotifier(redis));
    orderQueue = createOrderQueue(config.REDIS_URL, prefix);
    scheduledQueue = createScheduledQueue(config.REDIS_URL, prefix);
    scheduledEvents = new QueueEvents(SCHEDULED_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix });
    await scheduledEvents.waitUntilReady();
    orders = new OrderService(pool, marketData, new QueueDispatcher(orderQueue));
    portfolio = new PortfolioService(pool, marketData);
    auth = new AuthService(pool, config);
    const eod = new EodService(pool, new PriceIngestService(pool, provider), execution);
    workers = createWorkers(
      { pool, execution, eod, marketData, orders },
      { connection: bullConnection(config.REDIS_URL), prefix, staleAfterMs: 0 },
    );
  });

  afterAll(async () => {
    await workers.close();
    await scheduledEvents.close();
    await orderQueue.obliterate({ force: true });
    await scheduledQueue.obliterate({ force: true });
    await Promise.all([orderQueue.close(), scheduledQueue.close()]);
    await redis.quit();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, orders, order_events, holdings, cash_ledger, daily_prices RESTART IDENTITY CASCADE');
    provider.bars = [];
    userId = (await auth.register({ email: `w${randomUUID()}@test.dev`, password: 'password123', name: 'W' })).user.id;
  });

  const status = async (id: string) => (await orders.getOrder(userId, id)).status;

  it('API side returns VALIDATED immediately; the worker fills it asynchronously', async () => {
    const { order } = await orders.placeOrder({
      userId,
      input: { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 2 },
      idempotencyKey: 'worker-key-1',
      requestId: 'req-from-api',
    });
    expect(order.status).toBe('VALIDATED');
    await until(async () => (await status(order.id)) === 'FILLED');

    const detail = await orders.getOrder(userId, order.id);
    expect(detail.fillPrice).toBe(1400);
    // The request id from the API survives the hop through Redis into the worker's events.
    expect(detail.events.filter((e) => e.toStatus === 'FILLED')[0]!.requestId).toBe('req-from-api');
    expect((await portfolio.getPortfolio(userId)).cash).toBe(1_000_000 - 2_800);
  });

  it('publishes order updates for the WebSocket layer', async () => {
    const sub = new Redis(config.REDIS_URL);
    const messages: string[] = [];
    sub.on('message', (_c, m) => messages.push(m));
    await sub.subscribe(ORDERS_CHANNEL);
    const { order } = await orders.placeOrder({
      userId,
      input: { symbol: 'TCS', side: 'BUY', type: 'MARKET', quantity: 1 },
      idempotencyKey: 'worker-key-2',
    });
    const msg = await until(async () => messages.map((m) => JSON.parse(m)).find((m) => m.order.id === order.id));
    expect(msg).toMatchObject({ userId, order: { status: 'FILLED' } });
    await sub.quit();
  });

  it('dispatching the same order twice creates a single job (jobId = orderId)', async () => {
    const id = randomUUID();
    const dispatcher = new QueueDispatcher(orderQueue);
    await orderQueue.pause();
    await dispatcher.dispatch({ orderId: id });
    await dispatcher.dispatch({ orderId: id });
    expect(await orderQueue.getJobCountByTypes('waiting', 'paused')).toBe(1);
    await orderQueue.remove(id);
    await orderQueue.resume();
  });

  it('the reconciler recovers an order whose enqueue was lost', async () => {
    const lost: OrderDispatcher = { dispatch: async () => undefined }; // API "crashed" before enqueueing
    const marketData = new MarketDataService(redis, provider, 1);
    const flaky = new OrderService(pool, marketData, lost);
    const { order } = await flaky.placeOrder({
      userId,
      input: { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 1 },
      idempotencyKey: 'worker-key-3',
    });
    expect(await status(order.id)).toBe('VALIDATED');

    const job = await scheduledQueue.add('reconcile', {});
    expect(await job.waitUntilFinished(scheduledEvents, 5000)).toEqual({ redispatched: 1 });
    await until(async () => (await status(order.id)) === 'FILLED');
  });

  it('the eod-close job ingests candles and fills crossed limit orders', async () => {
    const { order } = await orders.placeOrder({
      userId,
      input: { symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', quantity: 5, limitPrice: 1350 },
      idempotencyKey: 'worker-key-4',
    });
    await until(async () => (await status(order.id)) === 'OPEN');

    const tomorrow = istDateString(new Date(Date.now() + 86_400_000));
    provider.bars = [{ symbol: 'RELIANCE', date: tomorrow, open: 1380, high: 1390, low: 1345, close: 1360, volume: 100 }];
    const job = await scheduledQueue.add('eod-close', { date: tomorrow });
    const result = (await job.waitUntilFinished(scheduledEvents, 10_000)) as { sweeps: Array<{ filled: number }> };
    expect(result.sweeps.reduce((n, s) => n + s.filled, 0)).toBe(1);

    const filled = await orders.getOrder(userId, order.id);
    expect(filled.status).toBe('FILLED');
    expect(filled.fillPrice).toBe(1350);
    expect(filled.events.at(-1)?.requestId).toBe(`eod-${tomorrow}`);
  });

  it('quote-poll refreshes the cache and broadcasts prices', async () => {
    const job = await scheduledQueue.add('quote-poll', {});
    const res = (await job.waitUntilFinished(scheduledEvents, 5000)) as { quotes: number };
    expect(res.quotes).toBe(2); // only symbols the provider knows
    expect(JSON.parse((await redis.get('quote:TCS'))!).price).toBe(3000);
  });
});

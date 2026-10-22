import type { Express } from 'express';
import request from 'supertest';
import type { Container } from '../src/container';
import { registerUser, reset, setup } from './helpers';

describe('HTTP API', () => {
  let app: Express;
  let c: Container;
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(() => ({ app, c } = setup()));
  afterAll(() => c.close());
  beforeEach(async () => {
    await reset(c);
    ({ token } = await registerUser(app));
  });

  describe('platform', () => {
    it('GET /health and /ready', async () => {
      await request(app).get('/health').expect(200, { status: 'ok' });
      const ready = await request(app).get('/ready').expect(200);
      expect(ready.body).toMatchObject({ db: 'up', redis: 'up' });
    });

    it('echoes a valid X-Request-Id and generates one otherwise', async () => {
      const a = await request(app).get('/health').set('X-Request-Id', 'abc-123');
      expect(a.headers['x-request-id']).toBe('abc-123');
      const b = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces');
      expect(b.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('unknown routes use the standard error format', async () => {
      const res = await request(app).get('/api/v1/nope').expect(404);
      expect(res.body).toEqual({
        error: { code: 'NOT_FOUND', message: expect.any(String), requestId: res.headers['x-request-id'] },
      });
    });

    it('malformed JSON is a 400 VALIDATION_ERROR', async () => {
      const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{bad').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('auth', () => {
    it('register -> me shows ₹10,00,000', async () => {
      const me = await request(app).get('/api/v1/auth/me').set(auth()).expect(200);
      expect(me.body.cash).toBe(1_000_000);
    });

    it('validation errors list each failing field', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({ email: 'nope', password: 'x' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
      expect(paths).toEqual(['email', 'name', 'password']);
    });

    it('login with wrong password is 401 INVALID_CREDENTIALS', async () => {
      await request(app).post('/api/v1/auth/register').send({ email: 'x@test.dev', password: 'password123', name: 'X' });
      const res = await request(app).post('/api/v1/auth/login').send({ email: 'x@test.dev', password: 'wrongpass' }).expect(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('protected routes need a bearer token', async () => {
      const res = await request(app).get('/api/v1/portfolio').expect(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      await request(app).get('/api/v1/portfolio').set('Authorization', 'Bearer garbage').expect(401);
    });
  });

  describe('market data', () => {
    it('searches instruments with quotes', async () => {
      const res = await request(app).get('/api/v1/instruments').query({ q: 'reli' }).expect(200);
      expect(res.body[0]).toMatchObject({ symbol: 'RELIANCE', quote: { symbol: 'RELIANCE', price: expect.any(Number) } });
    });

    it('serves top movers and batch quotes', async () => {
      const top = await request(app).get('/api/v1/instruments/top').expect(200);
      expect(top.body.gainers).toHaveLength(5);
      const q = await request(app).get('/api/v1/quotes').query({ symbols: 'TCS,INFY' }).expect(200);
      expect(Object.keys(q.body).sort()).toEqual(['INFY', 'TCS']);
    });

    it('serves daily candles from daily_prices', async () => {
      await c.pool.query(
        `INSERT INTO daily_prices (symbol, date, open, high, low, close, volume) VALUES ('TCS', CURRENT_DATE - 1, 1, 2, 0.5, 1.5, 10)`,
      );
      const res = await request(app).get('/api/v1/instruments/TCS/candles').query({ range: '1M' }).expect(200);
      expect(res.body).toEqual([expect.objectContaining({ open: 1, high: 2, low: 0.5, close: 1.5 })]);
    });

    it('unknown symbol is 404', async () => {
      await request(app).get('/api/v1/instruments/NOTREAL').expect(404);
    });
  });

  describe('orders', () => {
    const buy = { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 2 };

    it('requires an Idempotency-Key header', async () => {
      const res = await request(app).post('/api/v1/orders').set(auth()).send(buy).expect(400);
      expect(res.body.error.message).toMatch(/Idempotency-Key/);
    });

    it('validates the order body (limit price required for LIMIT)', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set(auth())
        .set('Idempotency-Key', 'key-limit-missing')
        .send({ symbol: 'TCS', side: 'BUY', type: 'LIMIT', quantity: 1 })
        .expect(400);
      expect(res.body.error.details[0]).toMatchObject({ path: 'limitPrice' });
    });

    it('places a market order (201) and a replay returns the same order (200)', async () => {
      const first = await request(app).post('/api/v1/orders').set(auth()).set('Idempotency-Key', 'key-abc-001').send(buy).expect(201);
      expect(first.body.status).toBe('FILLED');
      const again = await request(app).post('/api/v1/orders').set(auth()).set('Idempotency-Key', 'key-abc-001').send(buy).expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.id).toBe(first.body.id);

      const list = await request(app).get('/api/v1/orders').set(auth()).expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('same key with a different body is 422', async () => {
      await request(app).post('/api/v1/orders').set(auth()).set('Idempotency-Key', 'key-abc-002').send(buy).expect(201);
      const res = await request(app)
        .post('/api/v1/orders')
        .set(auth())
        .set('Idempotency-Key', 'key-abc-002')
        .send({ ...buy, quantity: 3 })
        .expect(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('order detail carries the request id through every event', async () => {
      const placed = await request(app)
        .post('/api/v1/orders')
        .set(auth())
        .set('Idempotency-Key', 'key-abc-003')
        .set('X-Request-Id', 'trace-me-123')
        .send(buy)
        .expect(201);
      const detail = await request(app).get(`/api/v1/orders/${placed.body.id}`).set(auth()).expect(200);
      expect(detail.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['PLACED', 'VALIDATED', 'OPEN', 'FILLED']);
      expect(new Set(detail.body.events.map((e: { requestId: string }) => e.requestId))).toEqual(new Set(['trace-me-123']));
    });

    it('cancels an OPEN limit order and rejects cancelling it again with 409', async () => {
      const placed = await request(app)
        .post('/api/v1/orders')
        .set(auth())
        .set('Idempotency-Key', 'key-abc-004')
        .send({ symbol: 'TCS', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 100 })
        .expect(201);
      expect(placed.body.status).toBe('OPEN');
      const cancelled = await request(app).post(`/api/v1/orders/${placed.body.id}/cancel`).set(auth()).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      const again = await request(app).post(`/api/v1/orders/${placed.body.id}/cancel`).set(auth()).expect(409);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('filters orders by status', async () => {
      await request(app).post('/api/v1/orders').set(auth()).set('Idempotency-Key', 'key-abc-005').send(buy);
      await request(app)
        .post('/api/v1/orders')
        .set(auth())
        .set('Idempotency-Key', 'key-abc-006')
        .send({ symbol: 'TCS', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 100 });
      const open = await request(app).get('/api/v1/orders').query({ status: 'OPEN' }).set(auth()).expect(200);
      expect(open.body).toHaveLength(1);
      await request(app).get('/api/v1/orders').query({ status: 'BOGUS' }).set(auth()).expect(400);
    });
  });

  describe('portfolio', () => {
    it('shows holdings and the ledger after a fill', async () => {
      await request(app)
        .post('/api/v1/orders')
        .set(auth())
        .set('Idempotency-Key', 'key-pf-001')
        .send({ symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 3 })
        .expect(201);
      const p = await request(app).get('/api/v1/portfolio').set(auth()).expect(200);
      expect(p.body.holdings).toEqual([expect.objectContaining({ symbol: 'INFY', quantity: 3 })]);
      expect(p.body.cash).toBeLessThan(1_000_000);
      const ledger = await request(app).get('/api/v1/portfolio/ledger').set(auth()).expect(200);
      expect(ledger.body.map((l: { reason: string }) => l.reason)).toEqual(['BUY', 'DEPOSIT']);
    });
  });
});

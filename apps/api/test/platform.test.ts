import request from 'supertest';
import { registerUser, reset, setup } from './helpers';

describe('OpenAPI docs', () => {
  const { app, c } = setup();
  afterAll(() => c.close());

  it('serves a generated OpenAPI 3 document covering every route', async () => {
    const res = await request(app).get('/docs/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.0.3');
    const operations = Object.values(res.body.paths as Record<string, object>).flatMap((p) => Object.keys(p));
    expect(operations).toHaveLength(16); // + the /ws WebSocket, which OpenAPI does not describe
    const placeOrder = res.body.paths['/api/v1/orders'].post;
    expect(placeOrder.parameters.some((p: any) => p.name === 'Idempotency-Key')).toBe(true);
    expect(Object.keys(placeOrder.requestBody.content['application/json'].schema.properties)).toEqual(
      expect.arrayContaining(['symbol', 'side', 'type', 'quantity', 'limitPrice']),
    );
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await request(app).get('/docs/').expect(200);
    expect(res.text).toContain('swagger-ui');
  });
});

describe('rate limiting', () => {
  const { app, c } = setup({ RATE_LIMIT_AUTH_PER_MIN: '3', RATE_LIMIT_ORDERS_PER_MIN: '2' });
  afterAll(() => c.close());
  beforeEach(() => reset(c));

  it('limits login attempts per IP with 429 + Retry-After', async () => {
    const attempt = () => request(app).post('/api/v1/auth/login').send({ email: 'nobody@test.dev', password: 'whatever1' });
    for (let i = 0; i < 3; i += 1) await attempt().expect(401);
    const res = await attempt().expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits order placement per user, not globally', async () => {
    await c.redis.flushdb();
    const a = await registerUser(app);
    await c.redis.flushdb(); // registration consumed auth budget; reset so only orders count
    const b = await registerUser(app);
    const place = (token: string, key: string) =>
      request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ symbol: 'TCS', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 10 });
    await place(a.token, 'rl-key-0001').expect(201);
    await place(a.token, 'rl-key-0002').expect(201);
    await place(a.token, 'rl-key-0003').expect(429);
    await place(b.token, 'rl-key-0004').expect(201);
  });
});

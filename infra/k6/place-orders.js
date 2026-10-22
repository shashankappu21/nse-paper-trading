/**
 * k6 load test: order placement.
 *
 *   k6 run -e BASE_URL=http://localhost:4000 infra/k6/place-orders.js
 *   docker run --rm -i --network host -v "$PWD/infra/k6:/k6" grafana/k6 run -e BASE_URL=http://localhost:4000 /k6/place-orders.js
 *
 * Raise the API's per-IP/per-user rate limits for the run (RATE_LIMIT_AUTH_PER_MIN, RATE_LIMIT_ORDERS_PER_MIN),
 * otherwise most requests are (correctly) answered with 429.
 *
 * Traffic mix per iteration:
 *   70% market BUY (1 share)      -> 202 VALIDATED, queued for the worker
 *   20% limit BUY far below market -> 202, worker parks it OPEN (blocks ₹1-₹2 of cash)
 *   10% replay of an earlier Idempotency-Key -> must return 200 + Idempotent-Replayed and the SAME order id
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const USERS = Number(__ENV.USERS || 50);
const SYMBOLS = ['ITC', 'HDFCLIFE', 'ONGC', 'TATASTEEL', 'NTPC', 'POWERGRID', 'COALINDIA', 'JIOFIN', 'BEL', 'ETERNAL'];

const placeLatency = new Trend('order_place_duration', true);
const replays = new Counter('idempotent_replays');
const replayMismatch = new Counter('idempotent_replay_mismatch');

export const options = {
  setupTimeout: '120s',
  scenarios: {
    place_orders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: Number(__ENV.VUS || 50) },
        { duration: __ENV.HOLD || '60s', target: Number(__ENV.VUS || 50) },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    order_place_duration: ['p(95)<250', 'p(99)<500'],
    idempotent_replay_mismatch: ['count==0'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = { headers: { 'Content-Type': 'application/json' } };

export function setup() {
  const run = Date.now();
  const tokens = [];
  for (let i = 0; i < USERS; i += 1) {
    const res = http.post(
      `${BASE}/api/v1/auth/register`,
      JSON.stringify({ email: `k6-${run}-${i}@load.test`, password: 'loadtest123', name: `k6 ${i}` }),
      json,
    );
    check(res, { 'registered': (r) => r.status === 201 });
    tokens.push(res.json('token'));
  }
  return { tokens };
}

// Per-VU memory of keys this VU already used, for replays.
const sent = [];

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const roll = Math.random();

  if (roll < 0.1 && sent.length > 0) {
    const prev = sent[Math.floor(Math.random() * sent.length)];
    const res = http.post(`${BASE}/api/v1/orders`, JSON.stringify(prev.body), {
      headers: { ...headers, 'Idempotency-Key': prev.key },
      tags: { name: 'POST /orders (replay)' },
    });
    replays.add(1);
    const ok = check(res, {
      'replay: 200': (r) => r.status === 200,
      'replay: header set': (r) => r.headers['Idempotent-Replayed'] === 'true',
    });
    if (!ok || res.json('id') !== prev.id) replayMismatch.add(1);
  } else {
    const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const body =
      roll < 0.3
        ? { symbol, side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 1 + Math.round(Math.random() * 100) / 100 }
        : { symbol, side: 'BUY', type: 'MARKET', quantity: 1 };
    const key = crypto.randomUUID(); // k6 ships WebCrypto; no remote jslib import needed
    const res = http.post(`${BASE}/api/v1/orders`, JSON.stringify(body), {
      headers: { ...headers, 'Idempotency-Key': key },
      tags: { name: 'POST /orders' },
    });
    placeLatency.add(res.timings.duration);
    check(res, {
      'place: 201/202': (r) => r.status === 201 || r.status === 202,
      'place: has id': (r) => !!r.json('id'),
    });
    if (res.status === 201 || res.status === 202) {
      sent.push({ key, body, id: res.json('id') });
      if (sent.length > 50) sent.shift();
    }
  }
  sleep(Number(__ENV.SLEEP || 0.05));
}

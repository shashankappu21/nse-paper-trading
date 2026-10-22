# Load testing report

Tool: **k6** · Script: [`infra/k6/place-orders.js`](../infra/k6/place-orders.js) · Raw output:
[`infra/k6/results/`](../infra/k6/results)

## What is measured

Each virtual user (VU) logs in as its own freshly registered account (each starts with ₹10,00,000) and loops:

| Share | Request | Expected |
|---|---|---|
| 70% | Market BUY, 1 share of a random liquid NIFTY stock | `202` (queued) |
| 20% | Limit BUY at ₹1–₹2 (never crosses; the worker parks it OPEN and blocks cash) | `202` |
| 10% | **Replay** of one of this VU's earlier requests with the same `Idempotency-Key` and body | `200`, `Idempotent-Replayed: true`, **same order id** |

Thresholds (the run fails if any is breached): `http_req_failed < 1%`, order placement `p95 < 250 ms` and
`p99 < 500 ms`, `checks > 99%`, **zero replay mismatches**.

`POST /orders` is the most expensive endpoint: JWT verification, the idempotency lookup, an instrument lookup,
a Redis quote read, a transaction with a row lock + insert + 2 events + balance check + guarded update, a
BullMQ enqueue, and a re-read. The worker then does a second transaction per order.

## Environment

- Full Docker Compose stack (Postgres 16, Redis 7 with AOF, API, worker, nginx), production images.
- **One 4-vCPU machine** shared by k6, every container and the OS — numbers are a floor, not a ceiling.
- `MARKET_DATA_PROVIDER=fake` (deterministic prices, so Yahoo isn't hammered), `LOG_LEVEL=warn`,
  rate limits raised for the run (`RATE_LIMIT_*` env vars).

Reproduce:

```bash
RATE_LIMIT_AUTH_PER_MIN=100000 RATE_LIMIT_ORDERS_PER_MIN=1000000 LOG_LEVEL=warn docker compose up -d
docker run --rm -i --network host -v "$PWD/infra/k6:/k6" grafana/k6 run -e BASE_URL=http://localhost:4000 /k6/place-orders.js
```

## Results

| Scenario | VUs | Think time | API replicas | Requests | Throughput | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|---|---|---|
| **Baseline** | 50 | 50 ms | 1 | 31,240 | **353 req/s** | 73 ms | **105 ms** | 119 ms | **0** |
| Stress | 200 | 0 | 1 | 25,668 | 325 req/s | 505 ms | 568 ms | 615 ms | 0 |
| Stress, scaled out | 200 | 0 | 3 (nginx) | 31,587 | 397 req/s | 268 ms | 895 ms | 1.02 s | 0 |

Baseline in full (from `baseline-50vus.txt`):

```
✓ 'p(95)<250' p(95)=105.44ms      ✓ 'p(99)<500' p(99)=119.35ms
✓ 'rate<0.01' rate=0.00%          ✓ 'count==0' (idempotent_replay_mismatch)
idempotent_replays.............: 3103
order_place_duration...........: avg=69.48ms med=73.46ms p(90)=98.29ms p(95)=105.44ms p(99)=119.35ms max=153.79ms
http_req_failed................: 0.00% 0 out of 31240
http_reqs......................: 31240 353.05/s
```

The baseline was run twice on an idle host (p95 105.28 ms and 105.44 ms). A third run made while the Jest suite
was also running measured p95 126 ms and was discarded as contaminated.

## Asynchronous execution latency

Placement returns `202` before the order is filled, so the user-visible latency is placement **plus** queue
and execution time. Measured from the database (`filled_at − created_at`) over the 21,756 market orders of the
first baseline run:

| p50 | p95 | p99 | avg |
|---|---|---|---|
| **23 ms** | **40 ms** | 57 ms | 24 ms |

## Correctness under load

Speed is irrelevant if money leaks. After the run, these SQL checks were executed against all 27,924 orders:

| Invariant | Violations |
|---|---|
| Every FILLED buy has exactly one `BUY` ledger row equal to `−qty × fill_price` | **0** |
| No `(order_id, reason)` appears twice in the ledger | **0** |
| No user has a negative balance | **0** |
| Every OPEN limit buy has a `HOLD` of exactly `−qty × limit_price` | **0** |
| Every holding's quantity equals the net filled quantity for that user and symbol | **0** |
| Every order has a complete event trail for its status | **0** |
| Orders stuck in `VALIDATED` after the run | **0** |

## Analysis: where is the bottleneck?

`docker stats` sampled during the stress runs (CPU, 100% = one core):

| Run | API | Worker | Postgres | Redis |
|---|---|---|---|---|
| 1 API, 200 VUs | **~85–97%** (one replica) | ~58% | ~135–145% | ~23% |
| 3 APIs, 200 VUs | ~40–55% each | ~35–42% | **~130–155%** | ~16% |

1. **One API replica is CPU-bound on its single Node.js event loop.** At ~95% of a core it can't accept work
   faster, so extra VUs only add queueing: throughput stays flat (353 → 325 req/s) while p95 grows 105 → 568 ms.
   Importantly, it degrades by **queueing, not failing**: 0 errors.
2. **The API is stateless, so it scales out** — nothing else changed to run three replicas behind nginx (rate
   limits, idempotency, schedules and WebSocket fan-out all live in Redis/Postgres).
3. **But scaling out moved the bottleneck to Postgres** and the shared host: three replicas gave only +13%
   throughput, each replica sat at ~50% CPU, and tail latency got *worse* as more concurrent transactions
   competed for 4 cores. On real infrastructure the database would have its own machine; here, it's the same
   box as everything else.

### Next optimizations (in order of expected payoff)

1. **Fewer Postgres round trips per placement** (~11 today): cache the 50-row instrument table in memory; skip
   the post-dispatch re-read in queue mode; return the existing row from the idempotent insert path instead of
   a separate lookup.
2. **Balance snapshot column** maintained in the same transaction as each ledger insert, replacing a `SUM` on
   the hot path.
3. **PgBouncer** (transaction pooling) when running many API/worker replicas, so connections don't multiply.
4. **Separate database host** (RDS) — the single biggest change for throughput once the API is scaled out.
5. Batch-friendly worker: BullMQ concurrency is 16 per worker; with a dedicated DB, more worker replicas.

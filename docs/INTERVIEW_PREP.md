# Interview prep — presenting this project

## 30-second pitch

> "I built a broker-style paper trading platform for NSE stocks. Users get ₹10 lakh of virtual cash and trade
> NIFTY 50 stocks at real market prices. It's two Node/TypeScript services — an API that validates orders and
> puts them on a BullMQ queue, and a worker that executes them — on Postgres and Redis, with live prices over
> WebSockets and a React frontend. The interesting parts are on the money side: every rupee goes through a
> ledger, every fill is one transaction under a per-user lock, and order placement is idempotent so retries can't
> double-buy. I wrote the order logic test-first, load-tested it with k6 at ~350 requests a second with zero
> errors, and then verified with SQL that not a single rupee was out of place across 28,000 orders."

## 2-minute architecture walkthrough (draw this)

1. **Browser → API** `POST /orders` with an `Idempotency-Key`. The API checks the key, reads the latest price
   from Redis, and in one transaction locks the user, inserts the order, runs pre-trade checks and marks it
   VALIDATED. Commits, enqueues `{orderId, requestId}`, returns **202**.
2. **Worker** picks the job, locks the user again, **re-checks** funds/holdings, and in one transaction moves the
   order OPEN → FILLED, writes the ledger debit and updates holdings. Publishes the update on Redis.
3. **API instances** subscribed to Redis push it over the user's WebSocket → "filled" toast.
4. **Limit orders** park as OPEN with cash blocked; a 4 pm IST scheduled job ingests the day's candles and fills
   those whose limit was crossed.
5. One **request id** follows the order through all of it — logs, events, the job.

## Questions you should expect

**Why no order book?**
Because this is a broker, not an exchange. Zerodha doesn't match my order against yours — NSE does, against the
whole market. With a few hundred users an internal book would mean orders don't fill and prices drift from NSE.
The real broker problems are money correctness, idempotency, risk checks and async execution — so that's what I
built. Trade-off: no partial fills or slippage. (ADR-001)

**How do you stop a user from spending the same money twice?**
Every money movement takes `SELECT … FOR UPDATE` on the user's row first, so one user's operations serialise.
The worker re-checks funds under that lock at fill time, because time passes between validation and execution.
Limit buys block cash with a HOLD ledger entry. I test it by firing two ₹6 L buys concurrently on a ₹10 L account:
one fills, one is rejected.

**Why not SERIALIZABLE isolation?**
It's correct but pushes serialization-failure retries onto every code path. A single explicit row lock is simpler
to reason about, and since operations are per-user, there's no cross-user contention to lose.

**Could the row locks deadlock?**
Not between my code paths: placement, execution and cancellation all lock **user first, then order**.
Consistent lock ordering is the standard way to rule out lock-ordering deadlocks.

**How does idempotency work? Why Postgres and not Redis?**
`UNIQUE(user_id, idempotency_key)` on orders, plus a hash of the request body. Same key and body → the original
order with 200; same key, different body → 422. In Postgres the key is written *in the same transaction* as
the order, so there's no window where one exists without the other, and it never expires. Five concurrent
identical requests produce exactly one order — that's a test.

**What happens if the API crashes after committing but before enqueueing?**
That's the dual-write problem. The order sits in VALIDATED. A reconciler job re-dispatches VALIDATED orders
older than 30 s every minute, and a client retry with the same key also re-dispatches. It's safe because
execution is idempotent. The textbook fix is a transactional outbox — I chose the reconciler for simplicity and
documented the outbox as the upgrade. There's a test that drops the enqueue and watches the reconciler recover.

**What if BullMQ delivers a job twice?**
Execution re-reads the order under the lock and does nothing unless it's still VALIDATED. And the ledger has
`UNIQUE(order_id, reason)`, so even a bug couldn't post the same debit twice.

**How do you compute P&L? Any rounding issues?**
I store cost basis, not average price. Sells remove a proportional share of cost; closing the position removes
all of it. Realised = proceeds − cost removed; unrealised = qty × LTP − cost basis. Everything in integer paise.
A test sells three ₹33.33… shares one at a time and checks the cost basis ends at exactly zero.

**How is caching done? What about stampedes and staleness?**
Read-through Redis cache with a 15 s TTL; a worker job refreshes all 50 quotes every 5 s in one batched provider
call and publishes them. Concurrent misses share one in-flight request (single-flight). Fills require a fresh
quote — they reject with PRICE_UNAVAILABLE rather than use a stale one — while display can fall back to the last
known price.

**How do WebSockets scale across multiple API instances?**
The worker publishes to Redis pub/sub; every API instance subscribes and forwards to its own sockets, filtered by
each socket's symbol subscriptions and authenticated user. No sticky sessions needed for broadcasts. Sockets
have heartbeats and slow-consumer protection.

**How did you test? Why real databases?**
Domain logic (state machine, P&L, checks) has pure unit tests. Everything else runs against real Postgres, Redis
and BullMQ, because the correctness lives in constraints, locks and transactions — a mocked DB can't fail a
unique constraint. 125 tests, 90% statement coverage. The order specs were committed red before implementation.

**What did the load test show?**
353 req/s with 50 VUs, p95 105 ms, zero errors; async fill latency p95 40 ms. At 200 VUs a single API pegs its
event loop — latency rises but nothing fails. Three replicas only gave +13% because Postgres became the
bottleneck on the shared 4-core box. Next steps: fewer queries per order, a balance snapshot, PgBouncer, a
separate DB host. And afterwards I ran SQL invariants over 28 k orders — zero violations.

**How would you scale it to 100× users?**
API and worker are stateless → more replicas behind a load balancer. Postgres to RDS with a read replica for
candles/portfolio reads; balance snapshot to avoid SUM; PgBouncer. Redis to ElastiCache. Partition the order
queue if one worker group isn't enough. If market-data fan-out becomes heavy, move ticks to a dedicated gateway.

**What would you do differently?**
Transactional outbox from the start; intraday limit fills from the quote stream; OpenTelemetry tracing keyed by
the request id; per-worker test databases so the integration suite runs in parallel.

## Bug stories (STAR format)

**The logout-on-refresh bug (React).**
*S:* After the frontend was done, every page refresh logged the user out. *T:* Find out why the token vanished.
*A:* I drove the app with Playwright and logged request headers: `/auth/me` went out once with the token, then
again without it. The culprit was `useEffect(() => setUnauthorizedHandler(signOut))` — the setter was an
assignment expression, so it *returned* `signOut`, and the arrow's implicit return made it the effect's cleanup.
React StrictMode runs cleanup right after mount in development, so it signed the user out on every load.
*R:* Block-bodied effect, setters typed to return `void`, grep for similar patterns. Lesson: an effect's return
value means something.

**The race condition in single-threaded JavaScript.**
*S:* The daily job reported ingesting 42 candles when the table had 250 new rows. *T:* Explain the mismatch.
*A:* Five concurrent async loops each did `bars += await upsert()`. JS reads `bars` before the `await` and writes
after it, so loops overwrite each other — a classic lost update, with no threads involved. *R:* Await into a
local, then add. I wrote a regression test, confirmed it fails on the old code and passes on the fix.

**Benchmark honesty.**
*S:* Scaling the API to three replicas was supposed to triple throughput. *A:* It gave +13%. `docker stats`
showed each API at 50% CPU and Postgres saturated on the shared 4-core host. *R:* I reported the real number
with the analysis instead of tuning the test — the bottleneck moved, which is exactly what scaling out is
supposed to reveal.

## Numbers cheat-sheet

16 REST endpoints + 1 WebSocket · 7 tables · 125 tests (90% coverage) · 353 req/s, p95 105 ms, 0 errors ·
fill latency p95 40 ms · 0 invariant violations / 27,924 orders · ~70 MB images · 4 stages.

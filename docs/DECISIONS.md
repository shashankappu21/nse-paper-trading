# Architecture decision records

Short ADRs for the decisions that shape this codebase. Each lists the context, the decision, the alternatives
that were considered, and the consequences — including the costs.

| # | Decision |
|---|---|
| [001](#adr-001-broker-model-no-order-book) | Broker model: no order book or matching engine |
| [002](#adr-002-shared-core-package-for-two-deployables) | Shared `core` package for two deployables |
| [003](#adr-003-the-cash-ledger-is-the-source-of-truth) | The cash ledger is the source of truth |
| [004](#adr-004-money-as-integer-paise-holdings-as-cost-basis) | Money as integer paise; holdings as cost basis |
| [005](#adr-005-per-user-row-lock-for-money-movements) | Per-user row lock for money movements |
| [006](#adr-006-explicit-order-state-machine-with-compare-and-set) | Explicit order state machine with compare-and-set |
| [007](#adr-007-idempotency-keys-enforced-by-postgres) | Idempotency keys enforced by Postgres |
| [008](#adr-008-async-execution-via-bullmq-with-idempotent-consumers) | Async execution via BullMQ with idempotent consumers |
| [009](#adr-009-reconciler-instead-of-a-transactional-outbox) | Reconciler instead of a transactional outbox (for now) |
| [010](#adr-010-limit-orders-filled-by-an-end-of-day-sweep) | Limit orders filled by an end-of-day sweep |
| [011](#adr-011-market-data-behind-an-interface-with-a-redis-read-through-cache) | Market data behind an interface with a Redis read-through cache |
| [012](#adr-012-realtime-via-redis-pubsub-fanned-out-by-each-api-instance) | Realtime via Redis pub/sub, fanned out by each API instance |
| [013](#adr-013-request-id-propagated-with-asynclocalstorage) | Request id propagated with AsyncLocalStorage |
| [014](#adr-014-integration-tests-against-real-postgres-and-redis) | Integration tests against real Postgres and Redis |
| [015](#adr-015-openapi-generated-from-zod) | OpenAPI generated from zod |
| [016](#adr-016-single-ec2-host-with-docker-compose-and-caddy) | Single EC2 host with Docker Compose and Caddy |

---

## ADR-001: Broker model, no order book

**Context.** A paper-trading app has a tiny user base relative to the real market. Users expect to trade at
NSE prices.

**Decision.** Model the system as a broker. Orders never match against each other; they fill against the
market price from a data feed. Market orders fill at the latest cached quote; limit orders are evaluated
against daily candles (ADR-010).

**Alternatives.**
- *Internal order book + matching engine (price-time priority).* Users would trade with each other; with low
  liquidity, orders wouldn't fill and prices would diverge from NSE — modelling an exchange we don't operate.
- *Hybrid (book that also fills against the market).* All the complexity of both, with no benefit to a user.

**Consequences.** + Realistic prices; the hard problems are the ones a broker backend really has (money
correctness, idempotency, risk checks, async execution, market data). − No partial fills, no slippage, no
depth; a large market order fills entirely at the last price. Each could be added inside `ExecutionService`.

## ADR-002: Shared core package for two deployables

**Context.** The API validates and enqueues; the worker executes. Both need the order, ledger and holdings logic.

**Decision.** Put domain, services, repositories, market data, queue definitions and migrations in
`packages/core`; `apps/api` and `apps/worker` are thin shells (HTTP/WebSocket; BullMQ consumers).

**Alternatives.** Keep logic in `apps/api` and import from the worker (inverted dependency between apps);
duplicate it (two sources of truth for money); a separate "execution service" with an HTTP API (network hop for
no gain).

**Consequences.** + One implementation; the worker can be tested with the same fixtures. − Both deployables
ship code they don't use (e.g. the worker includes `AuthService`) — negligible.

## ADR-003: The cash ledger is the source of truth

**Context.** "Every balance change goes through the ledger."

**Decision.** No `balance` column. Balance = `SUM(cash_ledger.amount)` per user. Reasons: `DEPOSIT`, `BUY`,
`SELL`, `HOLD` (negative, blocks cash for an open limit buy), `RELEASE` (positive, on fill or cancel).
`UNIQUE (order_id, reason)` prevents duplicate postings for an order.

**Alternatives.** A mutable `balance` column (fast, but no audit trail and easy to corrupt); balance column
*plus* ledger (fast and auditable, but two things to keep consistent).

**Consequences.** + Every rupee is explainable; blocked cash is automatically excluded from buying power; a
retried fill cannot double-debit. − `SUM` grows with history (an index on `(user_id, id)` keeps it fast at this
scale). Upgrade path: a snapshot column updated in the same transaction, with the `SUM` kept as a
reconciliation check.

## ADR-004: Money as integer paise; holdings as cost basis

**Context.** Floating-point money drifts; average prices round.

**Decision.** `NUMERIC(18,2)` in Postgres; integer paise in TypeScript (`toPaise`, `toSql`). Holdings store
`quantity`, `cost_basis` (total paid for the shares still held) and `realised_pnl`. Average price is derived.
On a partial sell, `cost_removed = round(cost_basis × sold / held)`; when the position is closed, the remaining
cost is removed exactly.

**Alternatives.** Store `avg_price` (rounding error accumulates on every partial sell); floats (no).

**Consequences.** + Exact to the paisa (unit-tested with 3 one-share sells of a ₹100 position). − Conversion at
the edges; DTOs expose rupees.

## ADR-005: Per-user row lock for money movements

**Context.** Two concurrent orders from one user must not both pass a funds check against the same cash.

**Decision.** Every read-then-write of a user's cash/holdings begins with `SELECT … FROM users WHERE id=$1 FOR
UPDATE` inside the transaction. Always lock **user, then order**.

**Alternatives.** `SERIALIZABLE` isolation (correct, but needs retry loops for serialization failures);
optimistic version column on a balance row (we have no balance row — ADR-003); advisory locks (equivalent,
less visible); a single-writer queue per user (more infrastructure).

**Consequences.** + Simple, provably correct, deadlock-free by lock ordering; tested with concurrent buys.
− One user's orders execute serially — fine for retail. Different users never contend.

## ADR-006: Explicit order state machine with compare-and-set

**Decision.** A transition table (`PLACED→VALIDATED|REJECTED`, `VALIDATED→OPEN|REJECTED`,
`OPEN→FILLED|CANCELLED|REJECTED`). Every change goes through `transitionOrder()`: check the table, run
`UPDATE … WHERE id=$1 AND status=$expected`, append `order_events`. Invalid transitions → `409
INVALID_STATE_TRANSITION`.

**Consequences.** + Illegal states are unrepresentable in code and rejected at the DB even under races; a full
audit trail per order. − Market orders write two transitions (VALIDATED→OPEN→FILLED) in one transaction.

## ADR-007: Idempotency keys enforced by Postgres

**Context.** Mobile networks retry; users double-click. A retry must never create a second order.

**Decision.** Required `Idempotency-Key` header on `POST /orders`. `UNIQUE (user_id, idempotency_key)` plus a
SHA-256 `request_hash` of the canonical body. Same key + same body → original order (`200`,
`Idempotent-Replayed: true`); same key + different body → `422`. Keys are scoped per user.

**Alternatives.** Redis `SET NX` with TTL (fast, but not atomic with the order insert: a crash between them
loses either the key or the order; and it expires); a separate idempotency table storing full responses
(Stripe-style — more general, more storage).

**Consequences.** + Atomic with the order, durable, race-safe (5 concurrent identical requests → 1 order). The
replay also re-dispatches a stuck VALIDATED order (ADR-009). − Keys never expire (fine: one small index entry
per order).

## ADR-008: Async execution via BullMQ with idempotent consumers

**Decision.** The API commits a `VALIDATED` order and enqueues `{orderId, requestId}` with `jobId = orderId`;
answers `202`. The worker executes with retries (5 attempts, exponential backoff). Execution is idempotent:
under the user lock it re-reads the order and no-ops unless still `VALIDATED`.

**Alternatives.** Keep execution in the API (simpler, but couples request latency and API scaling to execution
and makes the "two services" point moot); Kafka/SQS (heavier; BullMQ on the Redis we already run is enough at
this scale, and gives retries, backoff, schedulers and a dashboard ecosystem).

**Consequences.** + API latency independent of execution; worker scales separately; retries are safe.
− Clients must handle `VALIDATED` → final status asynchronously (WebSocket push or polling). − Redis must be
persistent (AOF on).

## ADR-009: Reconciler instead of a transactional outbox (for now)

**Context.** Commit-then-enqueue is a dual write: a crash in between leaves an order `VALIDATED` forever.

**Decision.** A repeatable `reconcile` job (60 s) re-dispatches `VALIDATED` orders older than 30 s (partial
index `WHERE status='VALIDATED'`), with a distinct job id so BullMQ's dedupe doesn't swallow it. A client retry
with the same key also re-dispatches.

**Alternatives.** Transactional outbox + relay (immediate and exact; more moving parts); enqueue *before*
commit (worker may see an order that doesn't exist yet, or one whose transaction rolled back).

**Consequences.** + Very little code; correct because execution is idempotent; tested by dropping a dispatch.
− Worst-case ~90 s delay in the crash case. The outbox is the documented upgrade.

## ADR-010: Limit orders filled by an end-of-day sweep

**Decision.** OPEN limit orders are evaluated by the `eod-close` job (16:00 IST, weekdays): ingest daily
candles, then for each date in a 5-day look-back window, fill BUY if `low ≤ limit`, SELL if `high ≥ limit`,
**at the limit price**, only for orders created before that session's 15:30 IST close. Limit buys block
`qty × limit` when they open.

**Alternatives.** Intraday evaluation on every quote tick (more realistic; needs per-tick scanning and makes
correctness depend on poll frequency); fill at the open on gaps (more favourable; requires knowing whether the
gap crossed at the open).

**Consequences.** + Uses free, reliable daily data; deterministic and testable; catch-up after missed runs.
− No intraday limit fills; conservative fill price; orders are GTC (no DAY expiry).

## ADR-011: Market data behind an interface with a Redis read-through cache

**Decision.** `PriceProvider` (Yahoo via `yahoo-finance2`, or a deterministic fake) behind `MarketDataService`:
`quote:{SYM}` (TTL 15 s) for fills, `quote:last:{SYM}` (no TTL) as a display-only fallback, single-flight for
concurrent misses, and a worker job that refreshes all quotes every 5 s and publishes them.

**Consequences.** + Fills never use unknown prices; the UI survives provider hiccups; Yahoo sees ~1 batched
request per 5 s regardless of user count; offline dev/CI/load tests via the fake. − Prices are up to one poll
interval stale (Yahoo itself is delayed); single-flight is per process.

## ADR-012: Realtime via Redis pub/sub, fanned out by each API instance

**Decision.** The worker publishes quotes and order updates to Redis channels. Each API instance subscribes and
forwards to its connected sockets based on per-socket subscriptions and the authenticated user id.

**Alternatives.** WebSocket server inside the worker (couples execution to connection handling); Socket.IO with
its Redis adapter (more features, more weight); Server-Sent Events (simpler, but one-directional — subscription
changes would need REST calls).

**Consequences.** + Horizontally scalable without sticky routing for broadcasts; the worker is unaware of
clients. − Pub/sub is fire-and-forget: a client that misses a message re-syncs via REST (React Query refetch on
reconnect / interval).

## ADR-013: Request id propagated with AsyncLocalStorage

**Decision.** Accept or generate `X-Request-Id`, bind it in AsyncLocalStorage, include it in every log line,
every `order_events` row and the BullMQ job payload; the worker restores it around job processing.

**Consequences.** + One id traces an order across HTTP → DB → queue → worker → WebSocket without threading a
parameter through every function. − ALS has a small overhead and needs care with callback-based libraries.

## ADR-014: Integration tests against real Postgres and Redis

**Decision.** Domain logic gets pure unit tests; everything touching persistence is tested against real
Postgres/Redis/BullMQ (service containers in CI). Test files run serially against one test database.

**Consequences.** + Tests exercise unique constraints, row locks, transaction rollback, Redis TTLs and real
queue semantics — where this system's correctness actually lives. − Slower (~10 s) and needs infrastructure;
upgrade: per-worker databases for parallelism.

## ADR-015: OpenAPI generated from zod

**Decision.** Build the OpenAPI 3 document from the shared zod schemas (`zod-to-openapi`) and serve Swagger UI
at `/docs`. A test asserts every route is documented.

**Consequences.** + Docs can't drift from validation. − Response schemas are declared separately from the TS
DTO interfaces (two declarations of response shapes).

## ADR-016: Single EC2 host with Docker Compose and Caddy

**Decision.** One EC2 instance runs Postgres, Redis, migrate, API, worker and Caddy (automatic HTTPS) via
Compose; the frontend is on Vercel.

**Alternatives.** ECS/Fargate + RDS + ElastiCache + ALB (production-grade, ~10× the cost and setup for a demo);
Kubernetes (far more than needed).

**Consequences.** + Cheap (~US$20/month), reproducible, shows real operational concerns (TLS, health-gated
startup, migrations on deploy, non-root images). − Single point of failure; vertical scaling only. Nothing in
the application assumes one host — the upgrade is infrastructure, not code.

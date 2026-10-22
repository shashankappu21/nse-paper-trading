-- Core schema for the paper trading broker.
-- Money is NUMERIC(18,2) rupees; application code works in integer paise.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE order_status AS ENUM ('PLACED', 'VALIDATED', 'OPEN', 'FILLED', 'CANCELLED', 'REJECTED');
CREATE TYPE order_side   AS ENUM ('BUY', 'SELL');
CREATE TYPE order_type   AS ENUM ('MARKET', 'LIMIT');
CREATE TYPE ledger_reason AS ENUM ('DEPOSIT', 'BUY', 'SELL', 'HOLD', 'RELEASE');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE instruments (
  symbol       TEXT PRIMARY KEY,           -- NSE trading symbol, e.g. RELIANCE
  yahoo_symbol TEXT NOT NULL UNIQUE,       -- e.g. RELIANCE.NS
  name         TEXT NOT NULL,
  sector       TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE daily_prices (
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  date   DATE NOT NULL,
  open   NUMERIC(18,2) NOT NULL,
  high   NUMERIC(18,2) NOT NULL,
  low    NUMERIC(18,2) NOT NULL,
  close  NUMERIC(18,2) NOT NULL,
  volume BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, date),               -- serves "prices by symbol and date"
  CHECK (low <= high)
);

CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES instruments(symbol),
  side            order_side NOT NULL,
  type            order_type NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  limit_price     NUMERIC(18,2) CHECK (limit_price IS NULL OR limit_price > 0),
  status          order_status NOT NULL DEFAULT 'PLACED',
  fill_price      NUMERIC(18,2),
  reject_reason   TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  filled_at       TIMESTAMPTZ,
  CHECK ((type = 'LIMIT') = (limit_price IS NOT NULL)),
  CHECK ((status = 'FILLED') = (fill_price IS NOT NULL)),
  UNIQUE (user_id, idempotency_key)         -- idempotent placement
);
-- "orders by user and status" (order book page, reserved-quantity checks)
CREATE INDEX orders_user_status_idx ON orders (user_id, status, created_at DESC);
-- the EOD sweep only scans OPEN limit orders; a partial index keeps it tiny
CREATE INDEX orders_open_limit_idx ON orders (symbol) WHERE status = 'OPEN' AND type = 'LIMIT';
-- reconciler for orders stuck before execution
CREATE INDEX orders_validated_idx ON orders (updated_at) WHERE status = 'VALIDATED';

CREATE TABLE order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status order_status,
  to_status   order_status NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);

CREATE TABLE holdings (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL REFERENCES instruments(symbol),
  quantity     INTEGER NOT NULL CHECK (quantity >= 0),
  cost_basis   NUMERIC(18,2) NOT NULL CHECK (cost_basis >= 0),  -- total invested in the open position
  realised_pnl NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE cash_ledger (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC(18,2) NOT NULL CHECK (amount <> 0),  -- signed: + credit, - debit
  reason     ledger_reason NOT NULL,
  order_id   UUID REFERENCES orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_ledger_user_idx ON cash_ledger (user_id, id);
-- at most one ledger row per (order, reason): a retried fill can never double-debit
CREATE UNIQUE INDEX cash_ledger_order_reason_uq ON cash_ledger (order_id, reason) WHERE order_id IS NOT NULL;

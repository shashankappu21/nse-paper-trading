export const ORDER_STATUSES = ['PLACED', 'VALIDATED', 'OPEN', 'FILLED', 'CANCELLED', 'REJECTED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_SIDES = ['BUY', 'SELL'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ['MARKET', 'LIMIT'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const LEDGER_REASONS = ['DEPOSIT', 'BUY', 'SELL', 'HOLD', 'RELEASE'] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const REJECT_REASONS = [
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_HOLDINGS',
  'INSTRUMENT_NOT_TRADABLE',
  'PRICE_UNAVAILABLE',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'IDEMPOTENCY_KEY_REUSED',
  'INVALID_STATE_TRANSITION',
  'PRICE_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

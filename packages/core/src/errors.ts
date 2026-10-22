import type { ErrorCode } from '@nse/shared';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (message: string, details?: unknown) => new AppError('VALIDATION_ERROR', 400, message, details),
  unauthorized: (message = 'Authentication required') => new AppError('UNAUTHORIZED', 401, message),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password'),
  notFound: (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`),
  emailTaken: () => new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists'),
  conflict: (message: string) => new AppError('CONFLICT', 409, message),
  invalidTransition: (from: string, to: string) =>
    new AppError('INVALID_STATE_TRANSITION', 409, `Order cannot move from ${from} to ${to}`, { from, to }),
  idempotencyKeyReused: () =>
    new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      422,
      'This Idempotency-Key was already used with a different request body',
    ),
  priceUnavailable: (symbol: string) => new AppError('PRICE_UNAVAILABLE', 503, `No price available for ${symbol}`),
};

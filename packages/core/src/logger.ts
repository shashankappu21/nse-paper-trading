import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const rootLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: process.env.SERVICE_NAME ?? 'nse' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization', 'password', '*.password', 'passwordHash'],
  transport:
    process.env.NODE_ENV === 'development' && process.env.LOG_PRETTY !== 'false'
      ? { target: 'pino-pretty', options: { singleLine: true } }
      : undefined,
});

/** Run fn with a request context so every log line inside carries the requestId. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Logger bound to the current request/job context (falls back to the root logger). */
export function getLogger(): Logger {
  const ctx = storage.getStore();
  return ctx ? rootLogger.child(ctx) : rootLogger;
}

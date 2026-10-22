import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError, getLogger } from '@nse/core';

interface Options {
  name: string;
  limit: number;
  windowSeconds: number;
  key(req: Request): string;
}

/**
 * Fixed-window rate limiter in Redis (INCR + EXPIRE in one MULTI), shared by all API replicas.
 * Fails open: if Redis is unavailable we prefer serving traffic over rejecting it.
 */
export function rateLimit(redis: Redis, opts: Options): RequestHandler {
  return async (req, res, next) => {
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `rl:${opts.name}:${opts.key(req)}:${window}`;
    try {
      const results = await redis.multi().incr(key).expire(key, opts.windowSeconds, 'NX').exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      res.setHeader('RateLimit-Limit', String(opts.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.limit - count)));
      if (count > opts.limit) {
        const retryAfter = opts.windowSeconds - (Math.floor(Date.now() / 1000) % opts.windowSeconds);
        res.setHeader('Retry-After', String(retryAfter));
        return next(new AppError('RATE_LIMITED', 429, `Too many requests, retry in ${retryAfter}s`));
      }
    } catch (err) {
      getLogger().warn({ err, limiter: opts.name }, 'rate limiter unavailable, allowing request');
    }
    next();
  };
}

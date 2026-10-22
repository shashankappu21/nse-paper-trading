import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext } from '@nse/core';

const VALID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Accepts an incoming X-Request-Id (e.g. from a load balancer) or generates one,
 * echoes it back, and binds it to AsyncLocalStorage so every log line — and the
 * order events / queue jobs created by this request — carry it.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && VALID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  runWithContext({ requestId: id }, next);
};

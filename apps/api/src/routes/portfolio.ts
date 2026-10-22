import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../container';
import { handler } from '../middleware/handler';

export function portfolioRoutes(c: Container): Router {
  const r = Router();
  r.get('/', handler({}, async (_i, req, res) => res.json(await c.portfolio.getPortfolio(req.userId!))));
  r.get(
    '/ledger',
    handler({ query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async ({ query }, req, res) =>
      res.json(await c.portfolio.getLedger(req.userId!, query.limit)),
    ),
  );
  return r;
}

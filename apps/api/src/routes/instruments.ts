import { Router } from 'express';
import { z } from 'zod';
import { candlesQuerySchema, quotesQuerySchema, searchQuerySchema, symbolSchema } from '@nse/shared';
import type { Container } from '../container';
import { handler } from '../middleware/handler';

const symbolParams = z.object({ symbol: symbolSchema });

export function instrumentRoutes(c: Container): Router {
  const r = Router();
  r.get('/', handler({ query: searchQuerySchema }, async ({ query }, _req, res) => res.json(await c.instruments.search(query.q))));
  r.get('/top', handler({}, async (_i, _req, res) => res.json(await c.instruments.topMovers())));
  r.get('/:symbol', handler({ params: symbolParams }, async ({ params }, _req, res) => res.json(await c.instruments.get(params.symbol))));
  r.get(
    '/:symbol/candles',
    handler({ params: symbolParams, query: candlesQuerySchema }, async ({ params, query }, _req, res) =>
      res.json(await c.instruments.candles(params.symbol, query.range)),
    ),
  );
  return r;
}

export function quoteRoutes(c: Container): Router {
  const r = Router();
  r.get(
    '/',
    handler({ query: quotesQuerySchema }, async ({ query }, _req, res) =>
      res.json(Object.fromEntries(await c.marketData.getQuotes(query.symbols))),
    ),
  );
  return r;
}

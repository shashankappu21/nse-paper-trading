import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { Errors } from '@nse/core';

interface Schemas<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> {
  body?: B;
  query?: Q;
  params?: P;
}

export interface Parsed<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> {
  body: z.infer<B>;
  query: z.infer<Q>;
  params: z.infer<P>;
}

type Any = z.ZodAny;

/**
 * Wraps a route: validates body/query/params with zod (400 VALIDATION_ERROR on failure),
 * passes the typed result to the handler, and forwards async errors to the error middleware.
 */
export function handler<B extends ZodTypeAny = Any, Q extends ZodTypeAny = Any, P extends ZodTypeAny = Any>(
  schemas: Schemas<B, Q, P>,
  fn: (input: Parsed<B, Q, P>, req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const parts = { body: schemas.body, query: schemas.query, params: schemas.params };
    const input: Record<string, unknown> = {};
    const issues: Array<{ in: string; path: string; message: string }> = [];
    for (const [where, schema] of Object.entries(parts)) {
      const raw = (req as unknown as Record<string, unknown>)[where];
      if (!schema) {
        input[where] = raw;
        continue;
      }
      const result = schema.safeParse(raw ?? {});
      if (result.success) input[where] = result.data;
      else issues.push(...result.error.issues.map((i) => ({ in: where, path: i.path.join('.'), message: i.message })));
    }
    if (issues.length > 0) return next(Errors.validation('Request validation failed', issues));
    fn(input as unknown as Parsed<B, Q, P>, req, res).catch(next);
  };
}

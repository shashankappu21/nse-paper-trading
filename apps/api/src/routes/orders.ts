import { Router } from 'express';
import { z } from 'zod';
import { idempotencyKeySchema, listOrdersQuerySchema, placeOrderSchema } from '@nse/shared';
import { Errors } from '@nse/core';
import type { Container } from '../container';
import { handler } from '../middleware/handler';

const idParams = z.object({ id: z.string().uuid() });

export function orderRoutes(c: Container): Router {
  const r = Router();

  r.post(
    '/',
    handler({ body: placeOrderSchema }, async ({ body }, req, res) => {
      const key = idempotencyKeySchema.safeParse(req.header('idempotency-key'));
      if (!key.success) {
        throw Errors.validation('A valid Idempotency-Key header is required', key.error.issues.map((i) => i.message));
      }
      const { order, replayed } = await c.orders.placeOrder({
        userId: req.userId!,
        input: body,
        idempotencyKey: key.data,
        requestId: req.id as string,
      });
      if (replayed) res.setHeader('Idempotent-Replayed', 'true');
      // 202: accepted and queued for the execution worker; 201: already in its resting/final state.
      res.status(replayed ? 200 : order.status === 'VALIDATED' ? 202 : 201).json(order);
    }),
  );

  r.get(
    '/',
    handler({ query: listOrdersQuerySchema }, async ({ query }, req, res) => res.json(await c.orders.listOrders(req.userId!, query))),
  );

  r.get('/:id', handler({ params: idParams }, async ({ params }, req, res) => res.json(await c.orders.getOrder(req.userId!, params.id))));

  r.post(
    '/:id/cancel',
    handler({ params: idParams }, async ({ params }, req, res) =>
      res.json(await c.orders.cancelOrder(req.userId!, params.id, req.id as string)),
    ),
  );
  return r;
}

import { Router } from 'express';
import { loginSchema, registerSchema } from '@nse/shared';
import type { Container } from '../container';
import { authenticate } from '../middleware/auth';
import { handler } from '../middleware/handler';

export function authRoutes(c: Container): Router {
  const r = Router();
  r.post('/register', handler({ body: registerSchema }, async ({ body }, _req, res) => res.status(201).json(await c.auth.register(body))));
  r.post('/login', handler({ body: loginSchema }, async ({ body }, _req, res) => res.json(await c.auth.login(body))));
  r.get('/me', authenticate(c.auth), handler({}, async (_i, req, res) => res.json(await c.auth.me(req.userId!))));
  return r;
}

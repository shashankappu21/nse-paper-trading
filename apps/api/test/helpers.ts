import type { Express } from 'express';
import request from 'supertest';
import { loadConfig } from '@nse/core';
import { createApp } from '../src/app';
import { buildContainer, type Container } from '../src/container';

export function setup(env: Record<string, string> = {}): { app: Express; c: Container } {
  const c = buildContainer(loadConfig({ ...process.env, ...env }));
  return { app: createApp(c), c };
}

export async function reset(c: Container): Promise<void> {
  await c.pool.query('TRUNCATE users, orders, order_events, holdings, cash_ledger, daily_prices RESTART IDENTITY CASCADE');
  await c.redis.flushdb();
}

let n = 0;
export async function registerUser(app: Express): Promise<{ token: string; userId: string }> {
  n += 1;
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: `api${Date.now()}${n}@test.dev`, password: 'password123', name: 'Api User' })
    .expect(201);
  return { token: res.body.token, userId: res.body.user.id };
}

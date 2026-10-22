import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { Express } from 'express';
import { ORDERS_CHANNEL, QUOTES_CHANNEL } from '@nse/core';
import type { Container } from '../src/container';
import { attachRealtime } from '../src/ws/realtime';
import { registerUser, reset, setup } from './helpers';

function open(url: string): Promise<{ ws: WebSocket; messages: unknown[]; next: (pred?: (m: any) => boolean) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      messages.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    const next = (pred: (m: any) => boolean = () => true) =>
      new Promise<any>((res, rej) => {
        const found = messages.find(pred);
        if (found) return res(found);
        waiters.push({ pred, resolve: res });
        setTimeout(() => rej(new Error('no message')), 3000);
      });
    ws.on('open', () => resolve({ ws, messages, next }));
    ws.on('error', reject);
  });
}

describe('WebSocket realtime', () => {
  let app: Express;
  let c: Container;
  let server: Server;
  let rt: ReturnType<typeof attachRealtime>;
  let base: string;

  beforeAll(async () => {
    ({ app, c } = setup());
    server = createServer(app);
    rt = attachRealtime(server, c);
    await new Promise<void>((r) => server.listen(0, r));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    await new Promise((r) => setTimeout(r, 100)); // let the Redis subscriber attach
  });
  afterAll(async () => {
    await rt.close();
    await new Promise((r) => server.close(r));
    await c.close();
  });
  beforeEach(() => reset(c));

  it('sends a cached snapshot on subscribe, then only ticks for subscribed symbols', async () => {
    const { ws, next, messages } = await open(base);
    ws.send(JSON.stringify({ type: 'subscribe', symbols: ['TCS'] }));
    const snap = await next((m) => m.type === 'quote');
    expect(snap.data.symbol).toBe('TCS');

    const tick = { symbol: 'TCS', price: 1, previousClose: 1, change: 0, changePercent: 0, asOf: 'now' };
    await c.redis.publish(QUOTES_CHANNEL, JSON.stringify([{ ...tick, symbol: 'INFY' }, { ...tick, price: 4242 }]));
    const live = await next((m) => m.type === 'quote' && m.data.price === 4242);
    expect(live.data.symbol).toBe('TCS');
    expect(messages.some((m: any) => m.data?.symbol === 'INFY')).toBe(false);
    ws.close();
  });

  it('pushes order updates only to the owning user', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const a = await open(`${base}?token=${alice.token}`);
    const b = await open(`${base}?token=${bob.token}`);
    await new Promise((r) => setTimeout(r, 50));
    await c.redis.publish(ORDERS_CHANNEL, JSON.stringify({ userId: alice.userId, order: { id: 'o1', status: 'FILLED' } }));
    const msg = await a.next((m) => m.type === 'order');
    expect(msg.data).toMatchObject({ id: 'o1', status: 'FILLED' });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.messages.some((m: any) => m.type === 'order')).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  it('rejects an invalid token with close code 4401', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}?token=forged`);
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
  });

  it('answers malformed messages with an error frame', async () => {
    const { ws, next } = await open(base);
    ws.send('not json');
    expect((await next((m) => m.type === 'error')).message).toMatch(/subscribe/);
    ws.close();
  });
});

import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { QuoteDto, WsServerMessage } from '@nse/shared';
import { symbolSchema } from '@nse/shared';
import { ORDERS_CHANNEL, QUOTES_CHANNEL, getLogger, type OrderUpdateMessage } from '@nse/core';
import type { Container } from '../container';

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), symbols: z.array(symbolSchema).max(60) }),
  z.object({ type: z.literal('unsubscribe'), symbols: z.array(symbolSchema).max(60) }),
]);

interface Client {
  ws: WebSocket;
  userId: string | null;
  symbols: Set<string>;
  alive: boolean;
}

const MAX_SYMBOLS_PER_SOCKET = 100;
const MAX_BUFFERED_BYTES = 1_000_000;
const HEARTBEAT_MS = 30_000;

/**
 * Real-time push. The worker publishes quotes/order updates to Redis pub/sub; every API
 * instance subscribes and forwards to its own sockets, so the API can scale horizontally
 * without sticky routing of price updates.
 */
export function attachRealtime(server: Server, c: Container): { close(): Promise<void>; clientCount(): number } {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const clients = new Set<Client>();
  const sub = c.redis.duplicate();
  const log = getLogger().child({ component: 'ws' });

  const send = (client: Client, msg: WsServerMessage) => {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    // Slow consumer protection: drop ticks rather than buffer unbounded memory.
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    client.ws.send(JSON.stringify(msg));
  };

  void sub.subscribe(QUOTES_CHANNEL, ORDERS_CHANNEL);
  sub.on('message', (channel, raw) => {
    try {
      if (channel === QUOTES_CHANNEL) {
        const quotes = JSON.parse(raw) as QuoteDto[];
        for (const client of clients) {
          for (const q of quotes) if (client.symbols.has(q.symbol)) send(client, { type: 'quote', data: q });
        }
      } else if (channel === ORDERS_CHANNEL) {
        const { userId, order } = JSON.parse(raw) as OrderUpdateMessage;
        for (const client of clients) if (client.userId === userId) send(client, { type: 'order', data: order });
      }
    } catch (err) {
      log.warn({ err, channel }, 'bad pub/sub payload');
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Browsers cannot set headers on a WebSocket, so the JWT comes as ?token=. It is optional:
    // anonymous sockets get prices, authenticated ones also get their own order updates.
    let userId: string | null = null;
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (token) {
      try {
        userId = c.auth.verifyToken(token).sub;
      } catch {
        ws.close(4401, 'invalid token');
        return;
      }
    }
    const client: Client = { ws, userId, symbols: new Set(), alive: true };
    clients.add(client);

    ws.on('pong', () => (client.alive = true));
    ws.on('close', () => clients.delete(client));
    ws.on('message', async (data) => {
      let parsed: z.infer<typeof clientMessage>;
      try {
        parsed = clientMessage.parse(JSON.parse(data.toString()));
      } catch {
        send(client, { type: 'error', message: 'Expected {"type":"subscribe"|"unsubscribe","symbols":[...]}' });
        return;
      }
      if (parsed.type === 'unsubscribe') {
        parsed.symbols.forEach((s) => client.symbols.delete(s));
        return;
      }
      const fresh = parsed.symbols.filter((s) => !client.symbols.has(s));
      if (client.symbols.size + fresh.length > MAX_SYMBOLS_PER_SOCKET) {
        send(client, { type: 'error', message: `At most ${MAX_SYMBOLS_PER_SOCKET} symbols per connection` });
        return;
      }
      fresh.forEach((s) => client.symbols.add(s));
      // Snapshot from the cache so the client has a price before the next tick.
      const snapshot = await c.marketData.getQuotes(fresh).catch(() => new Map<string, QuoteDto>());
      for (const q of snapshot.values()) send(client, { type: 'quote', data: q });
    });
  });

  // Drop sockets that stopped answering pings (laptop sleep, dead NAT mapping).
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    clientCount: () => clients.size,
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.close(1001, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await sub.quit().catch(() => undefined);
    },
  };
}

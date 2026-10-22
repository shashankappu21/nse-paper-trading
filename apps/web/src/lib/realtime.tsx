import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OrderDto, QuoteDto, WsServerMessage } from '@nse/shared';
import { wsUrl } from './api';
import { useAuth } from './auth';
import { formatINR } from './format';
import { useToast } from './toast';

export type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * One WebSocket per tab, shared by every component. Components declare the symbols they
 * care about (ref-counted); the store re-subscribes after reconnects and exposes quotes
 * through useSyncExternalStore so only components showing a changed symbol re-render.
 */
class QuoteStore {
  private quotes = new Map<string, QuoteDto>();
  private listeners = new Map<string, Set<() => void>>();
  private refCounts = new Map<string, number>();
  private ws: WebSocket | null = null;
  state: ConnectionState = 'connecting';
  private stateListeners = new Set<() => void>();
  onOrder: ((o: OrderDto) => void) | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly url: string) {
    this.connect();
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.stateListeners.forEach((l) => l());
  }

  private connect() {
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState('live');
      const symbols = [...this.refCounts.keys()];
      if (symbols.length) ws.send(JSON.stringify({ type: 'subscribe', symbols }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as WsServerMessage;
      if (msg.type === 'quote') this.setQuote(msg.data);
      else if (msg.type === 'order') this.onOrder?.(msg.data);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.setState('offline');
      // Exponential backoff with jitter, capped at 15s.
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  setQuote(q: QuoteDto) {
    this.quotes.set(q.symbol, q);
    this.listeners.get(q.symbol)?.forEach((l) => l());
  }

  get(symbol: string): QuoteDto | undefined {
    return this.quotes.get(symbol);
  }

  listen(symbol: string, fn: () => void): () => void {
    const set = this.listeners.get(symbol) ?? new Set();
    set.add(fn);
    this.listeners.set(symbol, set);
    return () => set.delete(fn);
  }

  listenState(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  retain(symbols: string[]) {
    const fresh = symbols.filter((s) => {
      const n = this.refCounts.get(s) ?? 0;
      this.refCounts.set(s, n + 1);
      return n === 0;
    });
    if (fresh.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', symbols: fresh }));
  }

  release(symbols: string[]) {
    const gone = symbols.filter((s) => {
      const n = (this.refCounts.get(s) ?? 1) - 1;
      if (n <= 0) this.refCounts.delete(s);
      else this.refCounts.set(s, n);
      return n <= 0;
    });
    if (gone.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', symbols: gone }));
  }
}

const StoreContext = createContext<QuoteStore | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [store, setStore] = useState<QuoteStore | null>(null);

  // Reconnect with the new token whenever the user logs in or out.
  useEffect(() => {
    const s = new QuoteStore(wsUrl(token));
    setStore(s);
    return () => s.close();
  }, [token]);

  useEffect(() => {
    if (!store) return;
    store.onOrder = (order) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (order.status === 'FILLED') {
        toast({ tone: 'success', title: `${order.side} ${order.quantity} ${order.symbol} filled`, body: `at ${formatINR(order.fillPrice)}` });
      } else if (order.status === 'REJECTED') {
        toast({ tone: 'error', title: `${order.symbol} order rejected`, body: order.rejectReason?.replace(/_/g, ' ').toLowerCase() });
      } else if (order.status === 'OPEN') {
        toast({ tone: 'info', title: `${order.symbol} limit order open`, body: `${order.side} ${order.quantity} @ ${formatINR(order.limitPrice)}` });
      }
    };
  }, [store, qc, toast]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

const noop = () => () => undefined;

/** Live quote for one symbol; falls back to the REST snapshot until the first tick arrives. */
export function useLiveQuote(symbol: string | undefined, initial?: QuoteDto | null): QuoteDto | null {
  const store = useContext(StoreContext);
  useEffect(() => {
    if (!store || !symbol) return;
    store.retain([symbol]);
    return () => store.release([symbol]);
  }, [store, symbol]);
  useEffect(() => {
    if (store && initial && !store.get(initial.symbol)) store.setQuote(initial);
  }, [store, initial]);
  const live = useSyncExternalStore(
    store && symbol ? (fn) => store.listen(symbol, fn) : noop,
    () => (store && symbol ? store.get(symbol) : undefined),
  );
  return live ?? initial ?? null;
}

/** Subscribe a whole list (tables) without one hook call per row. */
export function useSubscribe(symbols: string[]): void {
  const store = useContext(StoreContext);
  const key = symbols.join(',');
  useEffect(() => {
    if (!store || !key) return;
    const list = key.split(',');
    store.retain(list);
    return () => store.release(list);
  }, [store, key]);
}

export function useConnectionState(): ConnectionState {
  const store = useContext(StoreContext);
  return useSyncExternalStore(store ? (fn) => store.listenState(fn) : noop, () => store?.state ?? 'connecting');
}

/** Adds a short green/red flash class when the value changes. */
export function useFlash(value: number | undefined): string {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (value === undefined || prev.current === undefined || value === prev.current) {
      prev.current = value;
      return;
    }
    setCls(value > prev.current ? 'flash-up' : 'flash-down');
    prev.current = value;
    const t = setTimeout(() => setCls(''), 900);
    return () => clearTimeout(t);
  }, [value]);
  return cls;
}

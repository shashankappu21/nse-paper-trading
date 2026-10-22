import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { placeOrderSchema, type OrderSide, type OrderType } from '@nse/shared';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatINR } from '../lib/format';
import { useToast } from '../lib/toast';
import { Card, Spinner } from './ui';

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Buy/sell ticket. The Idempotency-Key is generated once per *intent*: it is kept when the
 * user retries after a network error (so the retry can't double-buy) and replaced as soon
 * as the order inputs change or an order is accepted.
 */
export function OrderPanel({ symbol, ltp }: { symbol: string; ltp: number | null }) {
  const { user, cash } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [side, setSide] = useState<OrderSide>('BUY');
  const [type, setType] = useState<OrderType>('MARKET');
  const [qty, setQty] = useState('1');
  const [limit, setLimit] = useState('');
  const key = useRef(newKey());
  const [error, setError] = useState<string | null>(null);

  const portfolio = useQuery({ queryKey: ['portfolio'], queryFn: api.portfolio, enabled: !!user });
  const held = portfolio.data?.holdings.find((h) => h.symbol === symbol)?.quantity ?? 0;

  const resetKey = () => {
    key.current = newKey();
    setError(null);
  };

  const input = useMemo(
    () => ({ symbol, side, type, quantity: Number(qty), ...(type === 'LIMIT' ? { limitPrice: Number(limit) } : {}) }),
    [symbol, side, type, qty, limit],
  );
  const parsed = placeOrderSchema.safeParse(input); // same zod schema the API validates with
  const price = type === 'LIMIT' ? Number(limit) || 0 : (ltp ?? 0);
  const estimate = (Number(qty) || 0) * price;

  const mutation = useMutation({
    mutationFn: () => api.placeOrder(parsed.data!, key.current),
    onSuccess: ({ order, replayed }) => {
      resetKey();
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (order.status === 'REJECTED') {
        toast({ tone: 'error', title: 'Order rejected', body: order.rejectReason?.replace(/_/g, ' ').toLowerCase() });
      } else if (order.status === 'FILLED') {
        toast({ tone: 'success', title: `${order.side} ${order.quantity} ${order.symbol} filled`, body: `at ${formatINR(order.fillPrice)}` });
      } else {
        toast({ tone: 'info', title: replayed ? 'Order already received' : 'Order placed', body: `Status: ${order.status}` });
      }
    },
    onError: (err) => {
      // Keep the key: pressing the button again is a retry of the same order.
      setError(err instanceof ApiError ? `${err.message}${err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''}` : 'Something went wrong');
    },
  });

  const setAndReset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    resetKey();
  };

  const tone = side === 'BUY' ? 'bg-brand hover:bg-brand-dark' : 'bg-loss hover:brightness-95';
  const insufficient = side === 'BUY' ? cash !== null && estimate > cash : Number(qty) > held;

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-2 border-b border-line text-sm font-semibold">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setAndReset(setSide)(s)}
            className={`py-3 ${side === s ? (s === 'BUY' ? 'border-b-2 border-brand text-brand' : 'border-b-2 border-loss text-loss') : 'text-muted'}`}
          >
            {s === 'BUY' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <div className="space-y-4 p-5">
        <div className="flex gap-2">
          {(['MARKET', 'LIMIT'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setAndReset(setType)(t);
                if (t === 'LIMIT' && !limit && ltp) setLimit(ltp.toFixed(2));
              }}
              className={`flex-1 rounded-lg border py-1.5 text-sm ${type === t ? 'border-ink-strong font-semibold text-ink-strong' : 'border-line text-muted'}`}
            >
              {t === 'MARKET' ? 'Market' : 'Limit'}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted">Quantity</span>
          <input
            inputMode="numeric"
            value={qty}
            onChange={(e) => setAndReset(setQty)(e.target.value.replace(/[^0-9]/g, ''))}
            className="num mt-1 w-full rounded-lg border border-line px-3 py-2 text-right outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-muted">{type === 'MARKET' ? 'Price (market)' : 'Limit price'}</span>
          <input
            inputMode="decimal"
            disabled={type === 'MARKET'}
            value={type === 'MARKET' ? (ltp?.toFixed(2) ?? '') : limit}
            onChange={(e) => setAndReset(setLimit)(e.target.value.replace(/[^0-9.]/g, ''))}
            className="num mt-1 w-full rounded-lg border border-line px-3 py-2 text-right outline-none focus:border-brand disabled:bg-canvas disabled:text-muted"
          />
        </label>
        {type === 'LIMIT' && (
          <p className="text-xs text-muted">Limit orders stay open and are checked against the day&apos;s high/low after market close.</p>
        )}

        <div className="space-y-1 rounded-lg bg-canvas px-3 py-2.5 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">{side === 'BUY' ? 'Approx. required' : 'Approx. proceeds'}</span>
            <span className="num font-semibold text-ink-strong">{formatINR(estimate)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">{side === 'BUY' ? 'Available cash' : 'Shares held'}</span>
            <span className="num">{side === 'BUY' ? formatINR(cash) : held}</span>
          </div>
        </div>

        {error && <p className="rounded-lg bg-loss-soft px-3 py-2 text-xs text-loss">{error}</p>}
        {user && insufficient && parsed.success && (
          <p className="text-xs text-loss">{side === 'BUY' ? 'Not enough cash for this order.' : 'You do not hold enough shares.'}</p>
        )}

        {user ? (
          <button
            disabled={!parsed.success || mutation.isPending}
            onClick={() => mutation.mutate()}
            className={`flex w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-bold text-white transition disabled:opacity-50 ${tone}`}
          >
            {mutation.isPending && <Spinner className="h-4 w-4 border-white/40 border-t-white" />}
            {error ? 'Retry' : side === 'BUY' ? 'Buy' : 'Sell'} {symbol}
          </button>
        ) : (
          <Link to="/login" className="block rounded-lg bg-brand py-3 text-center text-sm font-bold text-white">
            Log in to trade
          </Link>
        )}
      </div>
    </Card>
  );
}

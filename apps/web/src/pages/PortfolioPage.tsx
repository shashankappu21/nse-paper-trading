import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { HoldingDto } from '@nse/shared';
import { api } from '../lib/api';
import { formatDateTime, formatINR, formatPercent, formatSigned, toneClass } from '../lib/format';
import { useFlash, useLiveQuote, useSubscribe } from '../lib/realtime';
import { Card, Empty, ErrorState, PageLoader, StockAvatar, Tabs } from '../components/ui';

/** Re-values one holding on every tick; reports its live value upward for the totals. */
function HoldingRow({ h }: { h: HoldingDto }) {
  const q = useLiveQuote(h.symbol);
  const ltp = q?.price ?? h.lastPrice;
  const value = ltp !== null ? ltp * h.quantity : null;
  const pnl = value !== null ? value - h.investedValue : null;
  const pct = pnl !== null && h.investedValue ? (pnl / h.investedValue) * 100 : 0;
  const flash = useFlash(ltp ?? undefined);
  return (
    <Link to={`/stocks/${encodeURIComponent(h.symbol)}`} className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-line px-4 py-3 hover:bg-canvas sm:grid-cols-[1fr_6rem_8rem_8rem_9rem]">
      <span className="flex min-w-0 items-center gap-3">
        <StockAvatar symbol={h.symbol} name={h.name} size={34} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink-strong">{h.name}</span>
          <span className="block text-xs text-muted">
            {h.quantity} shares · avg {formatINR(h.avgPrice)}
          </span>
        </span>
      </span>
      <span className={`num hidden rounded px-1 text-right text-sm sm:block ${flash}`}>{formatINR(ltp)}</span>
      <span className="num hidden text-right text-sm sm:block">{formatINR(h.investedValue)}</span>
      <span className="num text-right text-sm font-semibold text-ink-strong sm:font-normal">{formatINR(value)}</span>
      <span className={`num hidden text-right text-sm sm:block ${toneClass(pnl)}`}>
        {pnl === null ? '—' : `${formatSigned(pnl)} (${formatPercent(pct)})`}
      </span>
    </Link>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`num mt-0.5 text-lg font-semibold ${tone ?? 'text-ink-strong'}`}>{value}</p>
    </div>
  );
}

export function PortfolioPage() {
  const [tab, setTab] = useState<'holdings' | 'ledger'>('holdings');
  const pf = useQuery({ queryKey: ['portfolio'], queryFn: api.portfolio, refetchInterval: 30_000 });
  const ledger = useQuery({ queryKey: ['ledger'], queryFn: api.ledger, enabled: tab === 'ledger' });
  const holdings = pf.data?.holdings;
  useSubscribe(useMemo(() => (holdings ?? []).map((h) => h.symbol), [holdings]));

  if (pf.isLoading) return <PageLoader />;
  if (pf.error) return <ErrorState message="Could not load your portfolio." onRetry={() => pf.refetch()} />;
  const p = pf.data!;
  const pct = p.investedValue ? (p.unrealisedPnl / p.investedValue) * 100 : 0;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-ink-strong">Holdings</h1>
      <Card className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
          <div>
            <p className="text-xs text-muted">Current value</p>
            <p className="num text-3xl font-bold text-ink-strong">{formatINR(p.currentValue)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted">Total returns</p>
            <p className={`num text-lg font-semibold ${toneClass(p.unrealisedPnl)}`}>
              {formatSigned(p.unrealisedPnl)} ({formatPercent(pct)})
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
          <Stat label="Invested" value={formatINR(p.investedValue)} />
          <Stat label="Realised P&L" value={formatSigned(p.realisedPnl)} tone={toneClass(p.realisedPnl)} />
          <Stat label="Available cash" value={formatINR(p.cash)} />
          <Stat label="Account value" value={formatINR(p.totalValue)} />
        </div>
      </Card>

      <Tabs value={tab} onChange={setTab} options={[{ value: 'holdings', label: `Holdings (${p.holdings.length})` }, { value: 'ledger', label: 'Cash ledger' }]} />

      {tab === 'holdings' ? (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1fr_6rem_8rem_8rem_9rem] px-4 py-2 text-xs font-medium text-muted sm:grid">
            <span>Company</span>
            <span className="text-right">LTP</span>
            <span className="text-right">Invested</span>
            <span className="text-right">Current</span>
            <span className="text-right">Returns</span>
          </div>
          {p.holdings.length === 0 ? (
            <Empty title="You don't own any stocks yet">
              <Link to="/" className="font-semibold text-brand">
                Explore stocks
              </Link>{' '}
              and start with your ₹10,00,000.
            </Empty>
          ) : (
            p.holdings.map((h) => <HoldingRow key={h.symbol} h={h} />)
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {ledger.isLoading ? (
            <PageLoader />
          ) : (
            (ledger.data ?? []).map((l) => (
              <div key={l.id} className="flex items-center justify-between border-t border-line px-4 py-3 first:border-t-0">
                <div>
                  <p className="text-sm font-medium text-ink-strong">{l.reason}</p>
                  <p className="text-xs text-muted">
                    {formatDateTime(l.createdAt)}
                    {l.orderId && <span className="ml-2 font-mono">order {l.orderId.slice(0, 8)}</span>}
                  </p>
                </div>
                <p className={`num text-sm font-semibold ${toneClass(l.amount)}`}>{formatSigned(l.amount)}</p>
              </div>
            ))
          )}
        </Card>
      )}
      <p className="text-xs text-muted">
        Every rupee movement is a ledger entry: limit buys block cash with a HOLD entry and release it on fill or cancel.
      </p>
    </div>
  );
}

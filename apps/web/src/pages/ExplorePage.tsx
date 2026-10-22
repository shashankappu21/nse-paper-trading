import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { InstrumentWithQuoteDto } from '@nse/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatINR, formatPercent, formatSigned, toneClass } from '../lib/format';
import { useFlash, useLiveQuote, useSubscribe } from '../lib/realtime';
import { Card, Change, ErrorState, PageLoader, StockAvatar, Tabs } from '../components/ui';

function MoverCard({ item }: { item: InstrumentWithQuoteDto }) {
  const q = useLiveQuote(item.symbol, item.quote);
  const flash = useFlash(q?.price);
  return (
    <Link to={`/stocks/${encodeURIComponent(item.symbol)}`} className="block">
      <Card className="h-full p-4 transition hover:shadow-md">
        <StockAvatar symbol={item.symbol} name={item.name} />
        <p className="mt-3 truncate text-sm font-medium text-ink-strong">{item.name}</p>
        <p className={`num mt-2 rounded text-base font-semibold text-ink-strong ${flash}`}>{formatINR(q?.price)}</p>
        {q && <Change change={q.change} percent={q.changePercent} className="text-xs" />}
      </Card>
    </Link>
  );
}

function StockRow({ item }: { item: InstrumentWithQuoteDto }) {
  const q = useLiveQuote(item.symbol, item.quote);
  const flash = useFlash(q?.price);
  return (
    <Link to={`/stocks/${encodeURIComponent(item.symbol)}`} className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-line px-4 py-3 hover:bg-canvas sm:grid-cols-[1fr_8rem_9rem]">
      <span className="flex min-w-0 items-center gap-3">
        <StockAvatar symbol={item.symbol} name={item.name} size={34} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink-strong">{item.name}</span>
          <span className="block text-xs text-muted">
            {item.symbol} · {item.sector}
          </span>
        </span>
      </span>
      <span className={`num rounded px-1 text-right text-sm font-semibold text-ink-strong ${flash}`}>{formatINR(q?.price)}</span>
      <span className={`num hidden text-right text-sm sm:block ${toneClass(q?.change)}`}>
        {q ? `${formatSigned(q.change)} (${formatPercent(q.changePercent)})` : '—'}
      </span>
    </Link>
  );
}

function InvestmentsSummary() {
  const { data } = useQuery({ queryKey: ['portfolio'], queryFn: api.portfolio });
  if (!data) return null;
  const pct = data.investedValue ? (data.unrealisedPnl / data.investedValue) * 100 : 0;
  return (
    <Link to="/portfolio" className="block">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5 transition hover:shadow-md">
        <div>
          <p className="text-xs text-muted">Your investments</p>
          <p className="num text-2xl font-bold text-ink-strong">{formatINR(data.currentValue)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted">Total returns</p>
          <p className={`num text-sm font-semibold ${toneClass(data.unrealisedPnl)}`}>
            {formatSigned(data.unrealisedPnl)} ({formatPercent(pct)})
          </p>
        </div>
      </Card>
    </Link>
  );
}

type SortKey = 'name' | 'gainers' | 'losers';

export function ExplorePage() {
  const { user } = useAuth();
  const [sort, setSort] = useState<SortKey>('name');
  const top = useQuery({ queryKey: ['top'], queryFn: api.top, refetchInterval: 60_000 });
  const all = top.data?.all;
  useSubscribe(useMemo(() => (all ?? []).map((i) => i.symbol), [all]));

  const sorted = useMemo(() => {
    const list = [...(all ?? [])];
    if (sort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name));
    return list.sort((a, b) => (sort === 'gainers' ? 1 : -1) * ((b.quote?.changePercent ?? 0) - (a.quote?.changePercent ?? 0)));
  }, [all, sort]);

  if (top.isLoading) return <PageLoader />;
  if (top.error) return <ErrorState message="Could not load market data." onRetry={() => top.refetch()} />;
  const data = top.data!;

  return (
    <div className="space-y-8">
      {user && <InvestmentsSummary />}
      <section>
        <h2 className="mb-3 text-lg font-bold text-ink-strong">Top gainers</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data.gainers.map((i) => (
            <MoverCard key={i.symbol} item={i} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-bold text-ink-strong">Top losers</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data.losers.map((i) => (
            <MoverCard key={i.symbol} item={i} />
          ))}
        </div>
      </section>
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-ink-strong">NIFTY 50</h2>
          <Tabs<SortKey>
            value={sort}
            onChange={setSort}
            options={[
              { value: 'name', label: 'A–Z' },
              { value: 'gainers', label: 'Gainers' },
              { value: 'losers', label: 'Losers' },
            ]}
          />
        </div>
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1fr_8rem_9rem] px-4 py-2 text-xs font-medium text-muted sm:grid">
            <span>Company</span>
            <span className="text-right">Market price</span>
            <span className="text-right">1D change</span>
          </div>
          {sorted.map((i) => (
            <StockRow key={i.symbol} item={i} />
          ))}
        </Card>
      </section>
    </div>
  );
}

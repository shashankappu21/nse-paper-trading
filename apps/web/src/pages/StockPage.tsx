import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatINR, formatSigned, toneClass } from '../lib/format';
import { useFlash, useLiveQuote } from '../lib/realtime';
import { CandleChart } from '../components/CandleChart';
import { OrderPanel } from '../components/OrderPanel';
import { Card, Change, Empty, ErrorState, PageLoader, Spinner, StockAvatar, Tabs } from '../components/ui';

const RANGES = ['1M', '3M', '6M', '1Y', '5Y'] as const;
type Range = (typeof RANGES)[number];

function Position({ symbol, ltp }: { symbol: string; ltp: number | null }) {
  const { data } = useQuery({ queryKey: ['portfolio'], queryFn: api.portfolio });
  const h = data?.holdings.find((x) => x.symbol === symbol);
  if (!h) return null;
  const value = ltp !== null ? ltp * h.quantity : h.currentValue;
  const pnl = value !== null ? value - h.investedValue : null;
  return (
    <Card className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
      {[
        ['Shares', String(h.quantity)],
        ['Avg. price', formatINR(h.avgPrice)],
        ['Current value', formatINR(value)],
      ].map(([k, v]) => (
        <div key={k}>
          <p className="text-xs text-muted">{k}</p>
          <p className="num font-semibold text-ink-strong">{v}</p>
        </div>
      ))}
      <div>
        <p className="text-xs text-muted">Returns</p>
        <p className={`num font-semibold ${toneClass(pnl)}`}>{pnl === null ? '—' : formatSigned(pnl)}</p>
      </div>
    </Card>
  );
}

export function StockPage() {
  const symbol = decodeURIComponent(useParams().symbol ?? '').toUpperCase();
  const { user } = useAuth();
  const [range, setRange] = useState<Range>('6M');
  const info = useQuery({ queryKey: ['instrument', symbol], queryFn: () => api.instrument(symbol) });
  const candles = useQuery({ queryKey: ['candles', symbol, range], queryFn: () => api.candles(symbol, range), placeholderData: (p) => p });
  const quote = useLiveQuote(symbol, info.data?.quote);
  const flash = useFlash(quote?.price);

  if (info.isLoading) return <PageLoader />;
  if (info.error) return <ErrorState message={`Could not find ${symbol}.`} />;
  const inst = info.data!;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        <div className="flex items-start gap-4">
          <StockAvatar symbol={inst.symbol} name={inst.name} size={52} />
          <div>
            <h1 className="text-xl font-bold text-ink-strong">{inst.name}</h1>
            <p className="text-xs text-muted">
              NSE: {inst.symbol} · {inst.sector}
            </p>
          </div>
        </div>
        <div>
          <p className={`num inline-block rounded px-1 text-3xl font-bold text-ink-strong ${flash}`}>{formatINR(quote?.price)}</p>
          {quote && (
            <p className="mt-1 text-sm">
              <Change change={quote.change} percent={quote.changePercent} /> <span className="text-muted">today</span>
            </p>
          )}
        </div>
        <Card className="p-3 sm:p-4">
          {candles.isLoading ? (
            <div className="flex h-[360px] items-center justify-center">
              <Spinner />
            </div>
          ) : candles.data && candles.data.length > 0 ? (
            <CandleChart candles={candles.data} livePrice={quote?.price} />
          ) : (
            <Empty title="No price history yet">Run the price ingest job to load daily candles.</Empty>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <Tabs<Range> value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: r }))} />
            {candles.isFetching && !candles.isLoading && <Spinner className="h-4 w-4" />}
          </div>
        </Card>
        {user && <Position symbol={symbol} ltp={quote?.price ?? null} />}
      </div>
      <div className="lg:sticky lg:top-24 lg:self-start">
        <OrderPanel symbol={symbol} ltp={quote?.price ?? null} />
      </div>
    </div>
  );
}

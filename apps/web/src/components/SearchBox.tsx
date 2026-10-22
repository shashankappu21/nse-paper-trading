import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatINR } from '../lib/format';
import { StockAvatar } from './ui';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchBox() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 200);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);

  const { data = [], isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.search(debounced),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = (symbol: string) => {
    setOpen(false);
    setQ('');
    navigate(`/stocks/${encodeURIComponent(symbol)}`);
  };

  const results = data.slice(0, 8);
  return (
    <div ref={box} className="relative w-full max-w-md">
      <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.4 9.83l3.63 3.63a.75.75 0 1 0 1.06-1.06l-3.63-3.63A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
      </svg>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          if (e.key === 'Enter' && results[active]) go(results[active].symbol);
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search NIFTY 50 stocks…"
        aria-label="Search stocks"
        className="w-full rounded-xl border border-line bg-canvas py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-brand focus:bg-white"
      />
      {open && debounced && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl border border-line bg-white shadow-xl">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">{isFetching ? 'Searching…' : 'No matching stocks'}</p>
          ) : (
            results.map((r, i) => (
              <button
                key={r.symbol}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r.symbol)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left ${i === active ? 'bg-canvas' : ''}`}
              >
                <StockAvatar symbol={r.symbol} name={r.name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-strong">{r.name}</span>
                  <span className="block text-xs text-muted">{r.symbol}</span>
                </span>
                <span className="num text-sm text-ink">{formatINR(r.quote?.price)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

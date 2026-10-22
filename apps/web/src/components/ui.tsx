import type { ReactNode } from 'react';
import type { OrderStatus } from '@nse/shared';
import { formatPercent, formatSigned, initials, toneClass } from '../lib/format';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white ${className}`}>{children}</div>;
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand ${className}`} aria-label="Loading" />;
}

export function PageLoader() {
  return (
    <div className="flex justify-center py-24">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-2xl border border-loss/30 bg-loss-soft px-5 py-4 text-sm text-loss">
      {message}
      {onRetry && (
        <button onClick={onRetry} className="ml-3 font-semibold underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="text-base font-semibold text-ink-strong">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

const PALETTE = ['#5367ff', '#00b386', '#f5a623', '#eb5b3c', '#7b61ff', '#00a3e0', '#d4419a', '#2f9e44'];

export function StockAvatar({ symbol, name, size = 40 }: { symbol: string; name: string; size?: number }) {
  const color = PALETTE[[...symbol].reduce((h, ch) => h + ch.charCodeAt(0), 0) % PALETTE.length];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white"
      style={{ width: size, height: size, background: color }}
      aria-hidden
    >
      {initials(name) || symbol.slice(0, 2)}
    </span>
  );
}

export function Change({ change, percent, className = '' }: { change: number; percent: number; className?: string }) {
  return (
    <span className={`num ${toneClass(change)} ${className}`}>
      {formatSigned(change)} ({formatPercent(percent)})
    </span>
  );
}

const STATUS_STYLE: Record<OrderStatus, string> = {
  PLACED: 'bg-canvas text-muted',
  VALIDATED: 'bg-amber-50 text-amber-700',
  OPEN: 'bg-blue-50 text-blue-700',
  FILLED: 'bg-brand-soft text-brand-dark',
  CANCELLED: 'bg-canvas text-muted',
  REJECTED: 'bg-loss-soft text-loss',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[status]}`}>{status}</span>;
}

export function SideTag({ side }: { side: 'BUY' | 'SELL' }) {
  return <span className={`text-xs font-bold ${side === 'BUY' ? 'text-brand' : 'text-loss'}`}>{side}</span>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`whitespace-nowrap rounded-full border px-4 py-1.5 text-sm font-medium transition ${
            o.value === value ? 'border-brand bg-brand-soft text-brand-dark' : 'border-line text-ink hover:bg-canvas'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

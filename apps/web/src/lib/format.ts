const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrCompact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** ₹10,00,000.00 — Indian digit grouping (lakh/crore). */
export const formatINR = (v: number | null | undefined) => (v == null ? '—' : inr.format(v));
export const formatINRCompact = (v: number) => inrCompact.format(v);
export const formatNumber = (v: number) => num.format(v);
export const formatSigned = (v: number) => `${v > 0 ? '+' : ''}${inr.format(v)}`;
export const formatPercent = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
export const toneClass = (v: number | null | undefined) => (v == null || v === 0 ? 'text-muted' : v > 0 ? 'text-brand' : 'text-loss');

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function initials(name: string): string {
  return name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

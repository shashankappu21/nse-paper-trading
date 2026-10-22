import type { QuoteDto } from '@nse/shared';
import { NIFTY_50 } from '../data/nifty50';
import type { DailyBar } from '../repositories/pricesRepo';
import { buildQuote, istDateString, round2, type PriceProvider } from './types';

/** Small seeded PRNG so the fake market is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const DAY = 86_400_000;

/**
 * Deterministic synthetic market for offline development, CI and load tests.
 * Daily closes follow a seeded random walk; intraday quotes oscillate around the
 * last close so the UI sees live movement.
 */
export class FakePriceProvider implements PriceProvider {
  readonly name = 'fake';
  private readonly base = new Map(NIFTY_50.map((i) => [i.symbol, i.basePrice]));

  /** Close for a given IST date: overlapping waves + daily noise, bounded around basePrice. */
  private closeOn(symbol: string, date: string): number {
    const base = this.base.get(symbol) ?? 1000;
    const d = Math.round((Date.parse(date) - Date.parse('2025-01-01')) / DAY);
    const h = hash(symbol);
    const slow = Math.sin(d / 45 + (h % 628) / 100) * 0.12;
    const medium = Math.sin(d / 12 + (h % 314) / 50) * 0.04;
    const noise = (mulberry32(hash(`${symbol}:${date}`))() - 0.5) * 0.02;
    return round2(base * (1 + slow + medium + noise));
  }

  async getQuotes(symbols: string[]): Promise<QuoteDto[]> {
    const now = new Date();
    const yesterday = istDateString(new Date(now.getTime() - DAY));
    return symbols
      .filter((s) => this.base.has(s))
      .map((s) => {
        const prev = this.closeOn(s, yesterday);
        const t = now.getTime() / 1000;
        const drift = Math.sin(t / 60 + (hash(s) % 50)) * 0.012 + Math.sin(t / 7 + hash(s)) * 0.002;
        return buildQuote(s, prev * (1 + drift), prev, now);
      });
  }

  async getDailyHistory(symbol: string, from: Date, to: Date): Promise<DailyBar[]> {
    if (!this.base.has(symbol)) return [];
    const bars: DailyBar[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      const date = istDateString(new Date(t));
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) continue; // NSE is closed at weekends
      const prevDate = istDateString(new Date(t - DAY));
      const open = this.closeOn(symbol, prevDate);
      const close = this.closeOn(symbol, date);
      const r = mulberry32(hash(`${symbol}:${date}:hl`));
      const high = round2(Math.max(open, close) * (1 + r() * 0.012));
      const low = round2(Math.min(open, close) * (1 - r() * 0.012));
      bars.push({ symbol, date, open, high, low, close, volume: Math.round(1e5 + r() * 5e6) });
    }
    return bars;
  }
}

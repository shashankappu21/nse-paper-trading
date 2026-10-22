import type { QuoteDto } from '@nse/shared';
import type { DailyBar } from '../repositories/pricesRepo';

/** Source of market data (Yahoo in production, a deterministic fake offline). */
export interface PriceProvider {
  readonly name: string;
  getQuotes(symbols: string[]): Promise<QuoteDto[]>;
  getDailyHistory(symbol: string, from: Date, to: Date): Promise<DailyBar[]>;
}

/** What order execution and valuation need: the latest price for a symbol. */
export interface QuoteSource {
  /** Strict: throws PRICE_UNAVAILABLE rather than returning a stale price. */
  getQuote(symbol: string): Promise<QuoteDto>;
  /** Best effort: symbols without a price are simply missing from the map. */
  getQuotes(symbols: string[]): Promise<Map<string, QuoteDto>>;
}

export const QUOTES_CHANNEL = 'quotes';
export const ORDERS_CHANNEL = 'orders';

/** Date in Asia/Kolkata as YYYY-MM-DD (NSE trading calendar). */
export function istDateString(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildQuote(symbol: string, price: number, previousClose: number, asOf: Date): QuoteDto {
  const change = round2(price - previousClose);
  return {
    symbol,
    price: round2(price),
    previousClose: round2(previousClose),
    change,
    changePercent: previousClose ? round2((change / previousClose) * 100) : 0,
    asOf: asOf.toISOString(),
  };
}

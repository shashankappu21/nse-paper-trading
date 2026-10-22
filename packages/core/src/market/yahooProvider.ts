import YahooFinance from 'yahoo-finance2';
import type { QuoteDto } from '@nse/shared';
import type { DailyBar } from '../repositories/pricesRepo';
import { buildQuote, istDateString, round2, type PriceProvider } from './types';

const toYahoo = (symbol: string) => `${symbol}.NS`;
const fromYahoo = (y: string) => y.replace(/\.NS$/, '');

/** NSE prices via the unofficial Yahoo Finance API (symbols like RELIANCE.NS). */
export class YahooPriceProvider implements PriceProvider {
  readonly name = 'yahoo';
  private readonly yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  async getQuotes(symbols: string[]): Promise<QuoteDto[]> {
    if (symbols.length === 0) return [];
    const results = await this.yf.quote(symbols.map(toYahoo), { return: 'array' });
    return results
      .filter((q) => typeof q.regularMarketPrice === 'number')
      .map((q) =>
        buildQuote(
          fromYahoo(q.symbol),
          q.regularMarketPrice as number,
          (q.regularMarketPreviousClose as number | undefined) ?? (q.regularMarketPrice as number),
          q.regularMarketTime instanceof Date ? q.regularMarketTime : new Date(),
        ),
      );
  }

  async getDailyHistory(symbol: string, from: Date, to: Date): Promise<DailyBar[]> {
    const chart = await this.yf.chart(toYahoo(symbol), { period1: from, period2: to, interval: '1d' });
    return chart.quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({
        symbol,
        date: istDateString(q.date),
        open: round2(q.open!),
        high: round2(q.high!),
        low: round2(q.low!),
        close: round2(q.close!),
        volume: q.volume ?? 0,
      }));
  }
}

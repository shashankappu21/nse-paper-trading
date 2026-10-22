import type { QuoteDto } from '@nse/shared';
import { createPool, type Pool, type QuoteSource, Errors, loadConfig } from '../src';

export const config = loadConfig();

export function testPool(): Pool {
  return createPool(config.DATABASE_URL, 5);
}

/** Wipes all per-user state between tests; instruments stay seeded. */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE users, orders, order_events, holdings, cash_ledger, daily_prices RESTART IDENTITY CASCADE');
}

/** Deterministic in-memory quote source so tests control the "market". */
export class StubQuotes implements QuoteSource {
  private prices = new Map<string, number>();

  set(symbol: string, price: number): this {
    this.prices.set(symbol, price);
    return this;
  }

  async getQuote(symbol: string): Promise<QuoteDto> {
    const price = this.prices.get(symbol);
    if (price === undefined) throw Errors.priceUnavailable(symbol);
    return { symbol, price, previousClose: price, change: 0, changePercent: 0, asOf: new Date().toISOString() };
  }

  async getQuotes(symbols: string[]): Promise<Map<string, QuoteDto>> {
    const out = new Map<string, QuoteDto>();
    for (const s of symbols) {
      if (this.prices.has(s)) out.set(s, await this.getQuote(s));
    }
    return out;
  }
}

let seq = 0;
export function uniqueEmail(): string {
  seq += 1;
  return `user${Date.now()}${seq}@test.dev`;
}

let keySeq = 0;
export function idemKey(): string {
  keySeq += 1;
  return `key-${Date.now()}-${keySeq}`;
}

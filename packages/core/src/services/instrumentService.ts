import type { CandleDto, InstrumentDto, InstrumentWithQuoteDto, QuoteDto } from '@nse/shared';
import type { Pool } from '../db/pool';
import { Errors } from '../errors';
import { istDateString, type QuoteSource } from '../market/types';
import { instrumentsRepo, type InstrumentRow } from '../repositories/instrumentsRepo';
import { pricesRepo } from '../repositories/pricesRepo';

const RANGE_DAYS: Record<string, number> = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '5Y': 1830 };

const toDto = (i: InstrumentRow): InstrumentDto => ({ symbol: i.symbol, name: i.name, sector: i.sector });

export class InstrumentService {
  constructor(
    private readonly pool: Pool,
    private readonly quotes: QuoteSource,
  ) {}

  async search(q: string): Promise<InstrumentWithQuoteDto[]> {
    const rows = await instrumentsRepo.search(this.pool, q);
    const quotes = await this.quotes.getQuotes(rows.map((r) => r.symbol));
    return rows.map((r) => ({ ...toDto(r), quote: quotes.get(r.symbol) ?? null }));
  }

  /** Top gainers and losers across the NIFTY 50 by % change on the day. */
  async topMovers(limit = 5): Promise<{ gainers: InstrumentWithQuoteDto[]; losers: InstrumentWithQuoteDto[]; all: InstrumentWithQuoteDto[] }> {
    const rows = await instrumentsRepo.listActive(this.pool);
    const quotes = await this.quotes.getQuotes(rows.map((r) => r.symbol));
    const all = rows
      .map((r) => ({ ...toDto(r), quote: quotes.get(r.symbol) ?? null }))
      .filter((r): r is InstrumentWithQuoteDto & { quote: QuoteDto } => r.quote !== null)
      .sort((a, b) => b.quote.changePercent - a.quote.changePercent);
    return { gainers: all.slice(0, limit), losers: all.slice(-limit).reverse(), all };
  }

  async get(symbol: string): Promise<InstrumentWithQuoteDto> {
    const row = await instrumentsRepo.findBySymbol(this.pool, symbol);
    if (!row) throw Errors.notFound(`Instrument ${symbol}`);
    const quotes = await this.quotes.getQuotes([symbol]);
    return { ...toDto(row), quote: quotes.get(symbol) ?? null };
  }

  async candles(symbol: string, range: string): Promise<CandleDto[]> {
    const row = await instrumentsRepo.findBySymbol(this.pool, symbol);
    if (!row) throw Errors.notFound(`Instrument ${symbol}`);
    const from = istDateString(new Date(Date.now() - (RANGE_DAYS[range] ?? 183) * 86_400_000));
    const bars = await pricesRepo.range(this.pool, symbol, from);
    return bars.map((b) => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  }
}

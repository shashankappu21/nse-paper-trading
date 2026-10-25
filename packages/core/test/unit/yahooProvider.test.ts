import { YahooPriceProvider } from '../../src/market/yahooProvider';

const mockQuote = jest.fn();
const mockChart = jest.fn();
jest.mock('yahoo-finance2', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ quote: mockQuote, chart: mockChart })),
}));

// Shapes below mirror real yahoo-finance2 v3 responses captured on 2026-10-23 (after validation/coercion).
const yQuote = (symbol: string, price: number | undefined, previousClose?: number, time?: Date) => ({
  symbol,
  regularMarketPrice: price,
  regularMarketPreviousClose: previousClose,
  regularMarketTime: time,
});
// Yahoo stamps NSE daily bars at the 09:15 IST open, i.e. 03:45 UTC.
const yBar = (date: string, o: number | null, h: number | null, l: number | null, c: number | null, volume: number | null = 1000) => ({
  date: new Date(`${date}T03:45:00Z`),
  open: o,
  high: h,
  low: l,
  close: c,
  volume,
});

describe('YahooPriceProvider', () => {
  let provider: YahooPriceProvider;
  beforeEach(() => {
    mockQuote.mockReset();
    mockChart.mockReset();
    provider = new YahooPriceProvider();
  });

  describe('getQuotes', () => {
    it('maps NSE symbols to Yahoo .NS tickers in one batched call and back again', async () => {
      const t = new Date('2026-10-23T09:58:19Z');
      mockQuote.mockResolvedValue([
        yQuote('M&M.NS', 2861.2, 2864.1, t),
        yQuote('BAJAJ-AUTO.NS', 10072, 10155, t),
        yQuote('TMPV.NS', 264.6, 270, t),
      ]);

      const quotes = await provider.getQuotes(['M&M', 'BAJAJ-AUTO', 'TMPV']);

      expect(mockQuote).toHaveBeenCalledTimes(1);
      expect(mockQuote).toHaveBeenCalledWith(['M&M.NS', 'BAJAJ-AUTO.NS', 'TMPV.NS'], { return: 'array' });
      expect(quotes.map((q) => q.symbol)).toEqual(['M&M', 'BAJAJ-AUTO', 'TMPV']);
      expect(quotes[0]).toEqual({
        symbol: 'M&M',
        price: 2861.2,
        previousClose: 2864.1,
        change: -2.9,
        changePercent: -0.1,
        asOf: '2026-10-23T09:58:19.000Z',
      });
    });

    it('does not call Yahoo for an empty list', async () => {
      expect(await provider.getQuotes([])).toEqual([]);
      expect(mockQuote).not.toHaveBeenCalled();
    });

    it('drops symbols Yahoo returned without a price (never fill at an unknown price)', async () => {
      mockQuote.mockResolvedValue([yQuote('TCS.NS', 2530, 2506.9, new Date()), yQuote('INFY.NS', undefined, 1153.35)]);
      const quotes = await provider.getQuotes(['TCS', 'INFY']);
      expect(quotes.map((q) => q.symbol)).toEqual(['TCS']);
    });

    it('rounds float noise to paise and falls back to price when previous close is missing', async () => {
      mockQuote.mockResolvedValue([yQuote('ADANIPORTS.NS', 1702.699951171875, undefined, new Date('2026-10-23T09:58:19Z'))]);
      const [q] = await provider.getQuotes(['ADANIPORTS']);
      expect(q).toMatchObject({ price: 1702.7, previousClose: 1702.7, change: 0, changePercent: 0 });
    });

    it('stamps asOf with the current time when Yahoo omits regularMarketTime', async () => {
      mockQuote.mockResolvedValue([yQuote('ITC.NS', 257.9, 258.9)]);
      const before = Date.now();
      const [q] = await provider.getQuotes(['ITC']);
      expect(Date.parse(q!.asOf)).toBeGreaterThanOrEqual(before);
    });

    it('propagates provider errors so callers can fall back or retry', async () => {
      mockQuote.mockRejectedValue(new Error('getaddrinfo ENOTFOUND query2.finance.yahoo.com'));
      await expect(provider.getQuotes(['TCS'])).rejects.toThrow('ENOTFOUND');
    });
  });

  describe('getDailyHistory', () => {
    const from = new Date('2026-10-19T00:00:00Z');
    const to = new Date('2026-10-24T00:00:00Z');

    it('requests daily bars for the .NS ticker over the given window', async () => {
      mockChart.mockResolvedValue({ quotes: [] });
      await provider.getDailyHistory('M&M', from, to);
      expect(mockChart).toHaveBeenCalledWith('M&M.NS', { period1: from, period2: to, interval: '1d' });
    });

    it('keys bars by IST trading date, rounds prices to paise and keeps our symbol', async () => {
      mockChart.mockResolvedValue({
        quotes: [
          yBar('2026-10-22', 1750, 1760.25, 1690.05, 1702.699951171875, 3_500_000),
          yBar('2026-10-23', 270, 270.55, 259.35, 264.6000061035156, 10_468_785),
        ],
      });
      const bars = await provider.getDailyHistory('TMPV', from, to);
      expect(bars).toEqual([
        { symbol: 'TMPV', date: '2026-10-22', open: 1750, high: 1760.25, low: 1690.05, close: 1702.7, volume: 3_500_000 },
        { symbol: 'TMPV', date: '2026-10-23', open: 270, high: 270.55, low: 259.35, close: 264.6, volume: 10_468_785 },
      ]);
    });

    it('uses the IST date even when the bar timestamp falls on the previous UTC day', async () => {
      // A bar stamped 00:00 IST on 1 Feb 2025 (the Saturday Budget-day session) is 18:30 UTC on 31 Jan.
      mockChart.mockResolvedValue({
        quotes: [{ date: new Date('2025-01-31T18:30:00Z'), open: 100, high: 101, low: 99, close: 100.5, volume: 10 }],
      });
      const [bar] = await provider.getDailyHistory('SBIN', from, to);
      expect(bar!.date).toBe('2025-02-01');
    });

    it('skips incomplete bars and treats missing volume as zero', async () => {
      mockChart.mockResolvedValue({
        quotes: [yBar('2026-10-21', null, null, null, null), yBar('2026-10-22', 100, 102, 98, 101, null)],
      });
      const bars = await provider.getDailyHistory('ITC', from, to);
      expect(bars).toHaveLength(1);
      expect(bars[0]).toMatchObject({ date: '2026-10-22', volume: 0 });
    });

    it('propagates provider errors so the ingest job can retry the symbol', async () => {
      mockChart.mockRejectedValue(new Error('fetch failed'));
      await expect(provider.getDailyHistory('TCS', from, to)).rejects.toThrow('fetch failed');
    });
  });
});

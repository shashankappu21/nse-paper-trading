import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import type { CandleDto } from '@nse/shared';

const UP = '#00b386';
const DOWN = '#eb5b3c';

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Daily candlesticks from daily_prices plus a volume histogram. When a live price arrives,
 * today's candle is updated in place (or appended), so the chart moves with the WebSocket feed.
 */
export function CandleChart({ candles, livePrice }: { candles: CandleDto[]; livePrice?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const last = useRef<CandlestickData<Time> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#7c7e8c', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: '#f3f3f5' }, horzLines: { color: '#f3f3f5' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#e9e9eb' },
      timeScale: { borderColor: '#e9e9eb' },
      // Explicit locale: the chart otherwise reads navigator.language, which can be an invalid tag (e.g. en-US@posix).
      localization: { locale: 'en-IN', priceFormatter: (p: number) => `₹${p.toFixed(2)}` },
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    volume.current = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current || !volume.current) return;
    const data = candles.map((d) => ({ time: d.time as Time, open: d.open, high: d.high, low: d.low, close: d.close }));
    series.current.setData(data);
    volume.current.setData(
      candles.map((d) => ({ time: d.time as Time, value: d.volume, color: d.close >= d.open ? 'rgba(0,179,134,0.25)' : 'rgba(235,91,60,0.25)' })),
    );
    last.current = data.at(-1) ?? null;
    chart.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const prev = last.current;
    if (!series.current || !prev || livePrice === undefined) return;
    const today = istToday() as Time;
    const bar =
      prev.time === today
        ? { ...prev, high: Math.max(prev.high, livePrice), low: Math.min(prev.low, livePrice), close: livePrice }
        : { time: today, open: prev.close, high: Math.max(prev.close, livePrice), low: Math.min(prev.close, livePrice), close: livePrice };
    series.current.update(bar);
    last.current = bar;
  }, [livePrice]);

  return <div ref={el} className="h-[360px] w-full" />;
}

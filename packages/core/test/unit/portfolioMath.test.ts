import { applyBuy, applySell, averagePrice, unrealisedPnl, EMPTY_POSITION } from '../../src';

describe('portfolio math (average cost method, integer paise)', () => {
  it('first buy sets cost basis and average price', () => {
    const p = applyBuy(EMPTY_POSITION, 10, 100_00);
    expect(p).toEqual({ quantity: 10, costBasis: 1000_00, realisedPnl: 0 });
    expect(averagePrice(p)).toBe(100_00);
  });

  it('second buy re-weights the average price', () => {
    const p = applyBuy(applyBuy(EMPTY_POSITION, 10, 100_00), 30, 120_00);
    expect(p.quantity).toBe(40);
    expect(p.costBasis).toBe(4600_00);
    expect(averagePrice(p)).toBe(115_00);
  });

  it('sell realises (sell price - avg price) * qty and keeps the average unchanged', () => {
    const bought = applyBuy(applyBuy(EMPTY_POSITION, 10, 100_00), 30, 120_00); // avg 115
    const { position, realised } = applySell(bought, 20, 130_00);
    expect(realised).toBe(300_00); // (130 - 115) * 20
    expect(position.quantity).toBe(20);
    expect(position.costBasis).toBe(2300_00);
    expect(position.realisedPnl).toBe(300_00);
    expect(averagePrice(position)).toBe(115_00);
  });

  it('a losing sell produces negative realised P&L', () => {
    const { realised } = applySell(applyBuy(EMPTY_POSITION, 5, 200_00), 5, 180_00);
    expect(realised).toBe(-100_00);
  });

  it('selling the full position zeroes quantity and cost basis but keeps realised P&L', () => {
    const { position } = applySell(applyBuy(EMPTY_POSITION, 3, 333_33), 3, 400_00);
    expect(position.quantity).toBe(0);
    expect(position.costBasis).toBe(0);
    expect(position.realisedPnl).toBe(3 * 400_00 - 3 * 333_33);
  });

  it('partial sells never leak paise through rounding', () => {
    // 3 shares for ₹100 total -> avg 33.333...; selling 1, 1, 1 must consume exactly 10000 paise of cost
    let p = applyBuy(EMPTY_POSITION, 3, 0);
    p = { ...p, costBasis: 100_00 };
    let realisedTotal = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = applySell(p, 1, 50_00);
      p = r.position;
      realisedTotal += r.realised;
    }
    expect(p.costBasis).toBe(0);
    expect(realisedTotal).toBe(150_00 - 100_00);
  });

  it('cannot sell more than held', () => {
    expect(() => applySell(applyBuy(EMPTY_POSITION, 1, 10_00), 2, 10_00)).toThrow();
  });

  it('unrealised P&L = quantity * last price - cost basis', () => {
    const p = applyBuy(EMPTY_POSITION, 10, 100_00);
    expect(unrealisedPnl(p, 112_50)).toBe(125_00);
    expect(unrealisedPnl(p, 90_00)).toBe(-100_00);
  });
});

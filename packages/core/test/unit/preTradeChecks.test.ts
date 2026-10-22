import { checkBuyingPower, checkSellableQuantity, orderValue } from '../../src';

describe('pre-trade checks', () => {
  it('orderValue multiplies quantity by price in paise', () => {
    expect(orderValue(7, 1234_55)).toBe(8641_85);
  });

  it('buy passes when cash covers the order exactly', () => {
    expect(checkBuyingPower(1000_00, 1000_00)).toEqual({ ok: true });
  });

  it('buy fails with INSUFFICIENT_FUNDS when cash is short by a paisa', () => {
    const r = checkBuyingPower(999_99, 1000_00);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_FUNDS');
  });

  it('sell passes when free quantity covers the order', () => {
    expect(checkSellableQuantity(10, 4, 6)).toEqual({ ok: true });
  });

  it('sell fails with INSUFFICIENT_HOLDINGS when quantity is reserved by other open sells', () => {
    const r = checkSellableQuantity(10, 5, 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INSUFFICIENT_HOLDINGS');
  });
});

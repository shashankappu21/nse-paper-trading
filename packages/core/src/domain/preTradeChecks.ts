import type { RejectReason } from '@nse/shared';
import type { Paise } from '../money';

export type CheckResult = { ok: true } | { ok: false; reason: RejectReason; message: string };

export function orderValue(quantity: number, price: Paise): Paise {
  return quantity * price;
}

export function checkBuyingPower(availableCash: Paise, required: Paise): CheckResult {
  if (availableCash >= required) return { ok: true };
  return {
    ok: false,
    reason: 'INSUFFICIENT_FUNDS',
    message: `Required ₹${(required / 100).toFixed(2)}, available ₹${(availableCash / 100).toFixed(2)}`,
  };
}

/** `reserved` is quantity already committed to other open/in-flight sell orders. */
export function checkSellableQuantity(held: number, reserved: number, requested: number): CheckResult {
  const free = held - reserved;
  if (free >= requested) return { ok: true };
  return { ok: false, reason: 'INSUFFICIENT_HOLDINGS', message: `Requested ${requested}, sellable ${Math.max(free, 0)}` };
}

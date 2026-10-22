import type { Paise } from '../money';

/** An open position valued with the average cost method. All amounts in paise. */
export interface Position {
  quantity: number;
  /** Total cost of the shares still held; avg price = costBasis / quantity. */
  costBasis: Paise;
  realisedPnl: Paise;
}

export const EMPTY_POSITION: Position = Object.freeze({ quantity: 0, costBasis: 0, realisedPnl: 0 });

export function applyBuy(pos: Position, quantity: number, price: Paise): Position {
  return {
    quantity: pos.quantity + quantity,
    costBasis: pos.costBasis + quantity * price,
    realisedPnl: pos.realisedPnl,
  };
}

/**
 * Selling removes a proportional share of the cost basis. Tracking the total cost
 * (rather than a rounded avg price) means the last share sold always consumes the
 * exact remaining cost, so no paise are lost to rounding.
 */
export function applySell(pos: Position, quantity: number, price: Paise): { position: Position; realised: Paise } {
  if (quantity > pos.quantity) throw new Error(`Cannot sell ${quantity}, only ${pos.quantity} held`);
  const costRemoved = quantity === pos.quantity ? pos.costBasis : Math.round((pos.costBasis * quantity) / pos.quantity);
  const realised = quantity * price - costRemoved;
  return {
    position: {
      quantity: pos.quantity - quantity,
      costBasis: pos.costBasis - costRemoved,
      realisedPnl: pos.realisedPnl + realised,
    },
    realised,
  };
}

/** Average buy price in (possibly fractional) paise. */
export function averagePrice(pos: Position): number {
  return pos.quantity === 0 ? 0 : pos.costBasis / pos.quantity;
}

export function unrealisedPnl(pos: Position, lastPrice: Paise): Paise {
  return pos.quantity * lastPrice - pos.costBasis;
}

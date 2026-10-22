import type { OrderStatus } from '@nse/shared';
import { Errors } from '../errors';

/**
 * Allowed order transitions. Anything not listed is rejected.
 *
 *   PLACED ──► VALIDATED ──► OPEN ──► FILLED
 *     │            │           ├────► CANCELLED
 *     └────────────┴───────────┴────► REJECTED
 */
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PLACED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['OPEN', 'REJECTED'],
  OPEN: ['FILLED', 'CANCELLED', 'REJECTED'],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw Errors.invalidTransition(from, to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

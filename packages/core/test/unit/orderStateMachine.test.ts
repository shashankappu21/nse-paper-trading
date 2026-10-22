import { ORDER_STATUSES, type OrderStatus } from '@nse/shared';
import { assertTransition, canTransition, isTerminal, AppError } from '../../src';

describe('order state machine', () => {
  const valid: Array<[OrderStatus, OrderStatus]> = [
    ['PLACED', 'VALIDATED'],
    ['PLACED', 'REJECTED'],
    ['VALIDATED', 'OPEN'],
    ['VALIDATED', 'REJECTED'],
    ['OPEN', 'FILLED'],
    ['OPEN', 'CANCELLED'],
    ['OPEN', 'REJECTED'],
  ];

  it.each(valid)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const invalid: Array<[OrderStatus, OrderStatus]> = ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.map((to): [OrderStatus, OrderStatus] => [from, to]),
  ).filter(([f, t]) => !valid.some(([vf, vt]) => vf === f && vt === t));

  it.each(invalid)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(AppError);
  });

  it('skipping straight from PLACED to FILLED is rejected with INVALID_STATE_TRANSITION', () => {
    try {
      assertTransition('PLACED', 'FILLED');
      fail('expected throw');
    } catch (err) {
      expect((err as AppError).code).toBe('INVALID_STATE_TRANSITION');
      expect((err as AppError).status).toBe(409);
    }
  });

  it('FILLED, CANCELLED and REJECTED are terminal', () => {
    expect(isTerminal('FILLED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('OPEN')).toBe(false);
  });
});

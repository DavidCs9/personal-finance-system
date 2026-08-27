import { describe, expect, it } from 'vitest';
import { movementAmountMinor, visibleMovementEvents } from './format';
import type { PurchaseEvent } from '../types';

const event = (overrides: Partial<PurchaseEvent> = {}): PurchaseEvent => ({
  id: 'event-1',
  institution: 'santander_mx',
  status: 'accepted',
  accountName: 'Santander',
  amount: { amountMinor: 1_000_00, currency: 'MXN' },
  merchantRaw: 'Compra compartida',
  receivedAt: '2026-08-01T12:00:00Z',
  ingestedAt: '2026-08-01T12:00:01Z',
  parserVersion: 'test',
  source: { kind: 'apple_pay_shortcut', requestId: 'request-1', cardRaw: 'Santander' },
  parseWarnings: [],
  revisions: [],
  ...overrides,
});

describe('movementAmountMinor', () => {
  it('shows Mi parte as the movement amount', () => {
    expect(movementAmountMinor(event({ personalAmountMinor: 250_00 }), '2026-08')).toBe(250_00);
  });
});

describe('visibleMovementEvents', () => {
  it('hides rejected events without removing them from the source feed', () => {
    const source = [event(), event({ id: 'event-2', status: 'rejected' })];
    expect(visibleMovementEvents(source).map((item) => item.id)).toEqual(['event-1']);
    expect(source).toHaveLength(2);
  });
});

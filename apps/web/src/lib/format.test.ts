import { describe, expect, it } from 'vitest';
import {
  eventDateLabel,
  eventRecencyKey,
  longEventDateLabel,
  movementAmountMinor,
  statusLabel,
  visibleMovementEvents,
} from './format';
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

describe('movement date formatting', () => {
  it('uses the system registration time for date-only bank evidence', () => {
    const movement = event({
      occurredAt: '2026-08-19T12:00:00.000Z',
      receivedAt: '2026-08-19T23:41:00.000Z',
      ingestedAt: '2026-08-19T23:42:15.000Z',
    });

    expect(eventDateLabel(movement)).toBe('19 ago, 5:42 p.m.');
    expect(longEventDateLabel(movement)).toBe('19 de agosto de 2026, 5:42 p.m.');
  });

  it('keeps a precise bank time when one exists', () => {
    const movement = event({
      occurredAt: '2026-08-19T22:05:00.000Z',
      ingestedAt: '2026-08-19T23:42:15.000Z',
    });

    expect(eventDateLabel(movement)).toBe('19 ago, 4:05 p.m.');
  });

  it('falls back completely to the system registration timestamp without bank date evidence', () => {
    const movement = event({
      occurredAt: undefined,
      receivedAt: '2026-08-20T00:01:00.000Z',
      ingestedAt: '2026-08-20T00:02:15.000Z',
    });

    expect(eventDateLabel(movement)).toBe('19 ago, 6:02 p.m.');
  });

  it('sorts same-day date-only evidence by its registration time', () => {
    const earlier = event({
      occurredAt: '2026-08-19T12:00:00.000Z',
      ingestedAt: '2026-08-19T20:00:00.000Z',
    });
    const later = event({
      id: 'event-2',
      occurredAt: '2026-08-19T12:00:00.000Z',
      ingestedAt: '2026-08-19T23:00:00.000Z',
    });

    expect(eventRecencyKey(later) > eventRecencyKey(earlier)).toBe(true);
  });
});

describe('visibleMovementEvents', () => {
  it('hides rejected events without removing them from the source feed', () => {
    const source = [event(), event({ id: 'event-2', status: 'rejected' })];
    expect(visibleMovementEvents(source).map((item) => item.id)).toEqual(['event-1']);
    expect(source).toHaveLength(2);
  });

  it('keeps pending foreign authorizations visible with an explicit status', () => {
    const pending = event({ status: 'pending_foreign', amount: { amountMinor: 19_28, currency: 'USD' } });
    expect(visibleMovementEvents([pending])).toEqual([pending]);
    expect(statusLabel[pending.status]).toBe('Esperando cargo MXN');
  });
});

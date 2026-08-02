import { describe, expect, it } from 'vitest';
import { buildMonthEventFeed, eventHasInstallmentInMonth } from '../lambda/event-month-feed.js';
import { eventMonthIndexKeys, eventMonthPartition, priorCalendarMonths } from '../lambda/event-month-index.js';
import { isValidMonth } from '../lambda/monthly-plan.js';

describe('GET /events month query contract', () => {
  it('requires YYYY-MM months', () => {
    expect(isValidMonth('2026-08')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('')).toBe(false);
  });
});

describe('event month index', () => {
  it('builds GSI3 keys from occurredAt spend month', () => {
    expect(eventMonthIndexKeys({
      eventId: 'evt-1',
      occurredAt: '2026-08-01T18:00:00.000Z',
      receivedAt: '2026-08-02T00:00:00.000Z',
    })).toEqual({
      spendMonth: '2026-08',
      GSI3PK: 'MONTH#2026-08',
      GSI3SK: '2026-08-01T18:00:00.000Z#evt-1',
    });
    expect(eventMonthPartition('2026-07')).toBe('MONTH#2026-07');
  });

  it('falls back to receivedAt when occurredAt is missing', () => {
    expect(eventMonthIndexKeys({
      eventId: 'evt-2',
      receivedAt: '2026-07-15T12:00:00.000Z',
    }).spendMonth).toBe('2026-07');
  });

  it('lists prior calendar months without including the target month', () => {
    expect(priorCalendarMonths('2026-08', 3)).toEqual(['2026-07', '2026-06', '2026-05']);
    expect(priorCalendarMonths('2026-01', 2)).toEqual(['2025-12', '2025-11']);
    expect(priorCalendarMonths('bad', 3)).toEqual([]);
  });
});

describe('month event feed', () => {
  const julyPurchase = {
    id: 'july-1',
    msi: {
      installments: [
        { month: '2026-07', status: 'spent' },
        { month: '2026-08', status: 'committed' },
        { month: '2026-09', status: 'committed' },
      ],
    },
  };
  const augustPurchase = { id: 'aug-1' };
  const julyNoMsi = { id: 'july-plain' };

  it('keeps August spend events out of a July feed', () => {
    const feed = buildMonthEventFeed('2026-07', [julyNoMsi], [augustPurchase]);
    expect(feed.events.map((event) => event.id)).toEqual(['july-plain']);
    expect(feed.msiRelated).toEqual([]);
  });

  it('surfaces MSI cuota months as msiRelated when the purchase was earlier', () => {
    expect(eventHasInstallmentInMonth(julyPurchase, '2026-08')).toBe(true);
    const feed = buildMonthEventFeed('2026-08', [augustPurchase], [julyPurchase, julyNoMsi]);
    expect(feed.events.map((event) => event.id)).toEqual(['aug-1']);
    expect(feed.msiRelated.map((event) => event.id)).toEqual(['july-1']);
  });

  it('does not duplicate an event that already appears in the spend-month list', () => {
    const sameMonthMsi = {
      id: 'aug-msi',
      msi: { installments: [{ month: '2026-08' }, { month: '2026-09' }] },
    };
    const feed = buildMonthEventFeed('2026-08', [sameMonthMsi], [sameMonthMsi]);
    expect(feed.msiRelated).toEqual([]);
  });
});

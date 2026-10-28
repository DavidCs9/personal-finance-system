import { describe, expect, it } from 'vitest';
import {
  computeMonthSummary,
  dailyBalancePushMessage,
  dayKeyInZone,
  formatMxnWhole,
  monthKeyInZone,
} from '@finance/domain';

describe('computeMonthSummary', () => {
  const now = new Date('2026-08-02T14:00:00-06:00');

  it('matches Resumen arithmetic for the current month', () => {
    const summary = computeMonthSummary({
      events: [
        { amountMinor: 1_000_00, status: 'accepted', receivedAt: '2026-08-01T12:00:00Z' },
        { amountMinor: 2_430_00, status: 'needs_review', receivedAt: '2026-08-02T12:00:00Z' },
        { amountMinor: 500_00, status: 'rejected', receivedAt: '2026-08-02T13:00:00Z' },
      ],
      month: '2026-08',
      incomeMinor: 21_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 8_000_00,
      now,
    });

    expect(summary.spentMinor).toBe(3_430_00);
    expect(summary.uncertainMinor).toBe(2_430_00);
    expect(summary.remainingMinor).toBe(21_000_00 - 3_430_00 - 8_000_00);
    expect(summary.isCurrentMonth).toBe(true);
    expect(summary.elapsedDays).toBe(2);
    expect(summary.daysInMonth).toBe(31);
    expect(summary.projectedSpendMinor).toBe(Math.round((3_430_00 / 2) * 31) + 8_000_00);
    expect(summary.projectedRemainingMinor).toBe(
      21_000_00 - (Math.round((3_430_00 / 2) * 31) + 8_000_00),
    );
  });

  it('ignores rejected purchases and other months', () => {
    const summary = computeMonthSummary({
      events: [
        { amountMinor: 100_00, status: 'accepted', receivedAt: '2026-07-15T12:00:00Z' },
        { amountMinor: 50_00, status: 'rejected', receivedAt: '2026-08-01T12:00:00Z' },
      ],
      month: '2026-08',
      incomeMinor: 10_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now,
    });
    expect(summary.spentMinor).toBe(0);
    expect(summary.remainingMinor).toBe(10_000_00);
  });

  it('keeps a pending foreign authorization out of spend until the MXN charge is posted', () => {
    const summary = computeMonthSummary({
      events: [
        { amountMinor: 19_28, status: 'pending_foreign', receivedAt: '2026-08-22T21:30:00Z' },
        { amountMinor: 326_96, status: 'accepted', receivedAt: '2026-08-22T22:00:00Z' },
      ],
      month: '2026-08',
      incomeMinor: 10_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now,
    });

    expect(summary.spentMinor).toBe(326_96);
    expect(summary.uncertainMinor).toBe(0);
  });

  it('uses Mi parte for shared non-MSI purchases and uncertainty', () => {
    const summary = computeMonthSummary({
      events: [
        {
          amountMinor: 1_000_00,
          personalAmountMinor: 250_00,
          status: 'accepted',
          receivedAt: '2026-08-01T12:00:00Z',
        },
        {
          amountMinor: 500_00,
          personalAmountMinor: 100_00,
          status: 'needs_review',
          receivedAt: '2026-08-02T12:00:00Z',
        },
      ],
      month: '2026-08',
      incomeMinor: 10_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now,
    });

    expect(summary.spentMinor).toBe(350_00);
    expect(summary.discretionarySpentMinor).toBe(350_00);
    expect(summary.uncertainMinor).toBe(100_00);
  });

  it('ignores Amex purchases deferred into MESES EN AUTOMÁTICO', () => {
    const summary = computeMonthSummary({
      events: [
        {
          amountMinor: 309_900,
          status: 'deferred_msi',
          receivedAt: '2026-05-08T12:00:00Z',
          occurredAt: '2026-05-08T12:00:00Z',
        },
        {
          amountMinor: 365_000,
          status: 'deferred_msi',
          receivedAt: '2026-06-03T12:00:00Z',
          occurredAt: '2026-06-03T12:00:00Z',
        },
        {
          amountMinor: 674_900,
          status: 'accepted',
          receivedAt: '2026-06-06T12:00:00Z',
          occurredAt: '2026-06-06T12:00:00Z',
          merchantRaw: 'MESES EN AUTOMÁTICO NACIONAL',
          msi: {
            months: 3,
            principalMinor: 674_900,
            cuotaMinor: 224_967,
            installments: [
              { index: 1, month: '2026-06', amountMinor: 224_967, status: 'spent' },
              { index: 2, month: '2026-07', amountMinor: 224_967, status: 'committed' },
              { index: 3, month: '2026-08', amountMinor: 224_967, status: 'committed' },
            ],
          },
        },
      ],
      month: '2026-06',
      incomeMinor: 50_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now: new Date('2026-06-15T12:00:00-06:00'),
    });
    expect(summary.spentMinor).toBe(224_967);
    expect(summary.discretionarySpentMinor).toBe(0);
    expect(summary.msiSpentMinor).toBe(224_967);
  });
});

describe('dailyBalancePushMessage', () => {
  const base = computeMonthSummary({
    events: [{ amountMinor: 12_430_00, status: 'accepted', receivedAt: '2026-08-01T12:00:00Z' }],
    month: '2026-08',
    incomeMinor: 250_000_00,
    incomeConfigured: true,
    upcomingPaymentsMinor: 0,
    now: new Date('2026-08-02T14:00:00-06:00'),
  });

  it('shows spent and remaining by default', () => {
    expect(base.projectedRemainingMinor).toBeGreaterThanOrEqual(0);
    expect(dailyBalancePushMessage(base, 'amounts', 'https://finance.castrodavid.dev/', '2026-08-02')).toEqual({
      title: 'Olbia · balance de hoy',
      body: `Has gastado ${formatMxnWhole(12_430_00)} este mes. Te quedan ${formatMxnWhole(base.remainingMinor)} después de compromisos.`,
      tag: 'daily-2026-08-02',
      navigate: 'https://finance.castrodavid.dev/',
    });
  });

  it('adds negative projection and omits uncertain when pace is at risk', () => {
    const summary = computeMonthSummary({
      events: [
        { amountMinor: 8_000_00, status: 'accepted', receivedAt: '2026-08-01T12:00:00Z' },
        { amountMinor: 500_00, status: 'needs_review', receivedAt: '2026-08-02T12:00:00Z' },
      ],
      month: '2026-08',
      incomeMinor: 10_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now: new Date('2026-08-02T14:00:00-06:00'),
    });
    expect(summary.projectedRemainingMinor).toBeLessThan(0);
    const message = dailyBalancePushMessage(summary, 'amounts', 'https://finance.castrodavid.dev/', '2026-08-02');
    expect(message.body).toContain(
      `A este ritmo gastarás ${formatMxnWhole(summary.projectedSpendMinor)}`,
    );
    expect(message.body).not.toContain('por confirmar');
  });

  it('mentions unconfirmed amounts when the projection is not negative', () => {
    const summary = computeMonthSummary({
      events: [
        { amountMinor: 1_000_00, status: 'accepted', receivedAt: '2026-08-01T12:00:00Z' },
        { amountMinor: 200_00, status: 'needs_review', receivedAt: '2026-08-02T12:00:00Z' },
      ],
      month: '2026-08',
      incomeMinor: 50_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now: new Date('2026-08-02T14:00:00-06:00'),
    });
    expect(dailyBalancePushMessage(summary, 'amounts', 'https://finance.castrodavid.dev/', '2026-08-02').body)
      .toContain(`Incluye ${formatMxnWhole(200_00)} por confirmar`);
  });

  it('asks to configure income without inventing availability', () => {
    const summary = computeMonthSummary({
      events: [{ amountMinor: 100_00, status: 'accepted', receivedAt: '2026-08-01T12:00:00Z' }],
      month: '2026-08',
      incomeMinor: 0,
      incomeConfigured: false,
      upcomingPaymentsMinor: 0,
      now: new Date('2026-08-02T14:00:00-06:00'),
    });
    expect(dailyBalancePushMessage(summary, 'amounts', 'https://finance.castrodavid.dev/', '2026-08-02').body)
      .toBe(`Has gastado ${formatMxnWhole(100_00)} este mes. Sube la nómina del mes para ver qué te queda.`);
  });

  it('hides amounts in private mode', () => {
    expect(dailyBalancePushMessage(base, 'private', 'https://finance.castrodavid.dev/', '2026-08-02').body)
      .toBe('Tu balance diario está listo.');
  });
});

describe('calendar helpers', () => {
  it('uses America/Chihuahua for month and day keys', () => {
    const lateNightUtc = new Date('2026-08-02T05:30:00Z');
    expect(monthKeyInZone(lateNightUtc)).toBe('2026-08');
    expect(dayKeyInZone(lateNightUtc)).toBe('2026-08-01');
  });
});

describe('explicit monthly fixed-charge reconciliation', () => {
  const now = new Date('2026-08-24T18:00:00Z');
  const other = { id: 'other', amountMinor: 1_000_00, currency: 'MXN', status: 'accepted', receivedAt: '2026-08-10T12:00:00Z' };
  const charge = { id: 'charge', amountMinor: 450_00, personalAmountMinor: 200_00,
    currency: 'MXN', status: 'accepted', receivedAt: '2026-08-18T12:00:00Z' };
  const payment = { id: 'service', amountMinor: 399_00, reconciliation: { eventId: 'charge', valid: true } };
  const input = { events: [other, charge], month: '2026-08', incomeMinor: 10_000_00,
    incomeConfigured: true, upcomingPaymentsMinor: 999_00, fixedPayments: [payment], now };

  it('replaces full programming coverage and removes the personal fixed charge from pace, without changing observed spend', () => {
    const linked = computeMonthSummary(input);
    const unlinked = computeMonthSummary({ ...input, fixedPayments: [{ id: payment.id, amountMinor: payment.amountMinor }] });
    expect(linked).toMatchObject({ spentMinor: 1_200_00, fixedSpentMinor: 200_00, discretionarySpentMinor: 1_000_00,
      billScheduledMinor: 399_00, billUpcomingMinor: 0, remainingMinor: 8_800_00, projectedSpendMinor: 1491_67 });
    expect(unlinked).toMatchObject({ spentMinor: linked.spentMinor, fixedSpentMinor: 0, billUpcomingMinor: 399_00,
      remainingMinor: 8401_00, projectedSpendMinor: 1949_00 });
    expect(unlinked.projectedSpendMinor - linked.projectedSpendMinor).toBe(457_33);
    expect(dailyBalancePushMessage(linked, 'amounts', '/', '2026-08-24').body).toContain('Te quedan $8,800');
  });

  it.each([
    { mine: 0, fixedSpent: 0, spent: 1000_00, projection: 1291_67 },
    { mine: 100_00, fixedSpent: 100_00, spent: 1100_00, projection: 1391_67 },
    { mine: undefined, fixedSpent: 450_00, spent: 1450_00, projection: 1741_67 },
  ])('uses current Mi parte $mine, including zero and absence, without inventing a partial balance', ({ mine, fixedSpent, spent, projection }) => {
    expect(computeMonthSummary({ ...input, events: [other, { ...charge, personalAmountMinor: mine }] }))
      .toMatchObject({ spentMinor: spent, fixedSpentMinor: fixedSpent, billUpcomingMinor: 0, projectedSpendMinor: projection });
  });

  it('keeps uncertain linked spend included and restores programming after rejection, then restores the relationship effect', () => {
    expect(computeMonthSummary({ ...input, events: [other, { ...charge, status: 'needs_review' }] }))
      .toMatchObject({ spentMinor: 1200_00, uncertainMinor: 200_00, fixedSpentMinor: 200_00, billUpcomingMinor: 0 });
    expect(computeMonthSummary({ ...input, events: [other, { ...charge, status: 'rejected' }] }))
      .toMatchObject({ spentMinor: 1000_00, fixedSpentMinor: 0, billUpcomingMinor: 399_00, remainingMinor: 8601_00 });
    expect(computeMonthSummary(input)).toMatchObject({ spentMinor: 1200_00, fixedSpentMinor: 200_00, billUpcomingMinor: 0 });
  });

  it('does not remove programming for absent, invalid, foreign, deferred, other-month or MSI charges', () => {
    const ineligible = [
      { ...input, events: [other] },
      { ...input, fixedPayments: [{ ...payment, reconciliation: { ...payment.reconciliation, valid: false } }] },
      { ...input, events: [other, { ...charge, currency: 'USD' }] },
      { ...input, events: [other, { ...charge, amountMinor: 0, personalAmountMinor: undefined }] },
      { ...input, events: [other, { ...charge, status: 'pending_foreign', currency: 'USD' }] },
      { ...input, events: [other, { ...charge, status: 'deferred_msi' }] },
      { ...input, events: [other, { ...charge, receivedAt: '2026-07-18T12:00:00Z' }] },
      { ...input, events: [other, { ...charge, msi: { months: 3, principalMinor: 450_00, cuotaMinor: 150_00,
        installments: [{ index: 1, month: '2026-08', amountMinor: 150_00, status: 'spent' as const }] } }] },
    ];
    for (const candidate of ineligible) expect(computeMonthSummary(candidate))
      .toMatchObject({ fixedSpentMinor: 0, billUpcomingMinor: 399_00 });
  });

  it('uses a newly confirmed full-coverage relationship and never borrows a prior-month relationship through inheritance', () => {
    // A new explicit confirmation may cover a different programmed amount; material edits invalidate it in storage.
    expect(computeMonthSummary({ ...input, fixedPayments: [{ ...payment, amountMinor: 500_00 }] }))
      .toMatchObject({ billScheduledMinor: 500_00, billUpcomingMinor: 0, fixedSpentMinor: 200_00, projectedSpendMinor: 1491_67 });
    expect(computeMonthSummary({ ...input, fixedPayments: [{ ...payment, amountMinor: 500_00,
      reconciliation: { ...payment.reconciliation, valid: false } }] }))
      .toMatchObject({ billScheduledMinor: 500_00, billUpcomingMinor: 500_00, fixedSpentMinor: 0, spentMinor: 1200_00 });
    expect(computeMonthSummary({ ...input, fixedPayments: [] }))
      .toMatchObject({ billScheduledMinor: 0, billUpcomingMinor: 0, fixedSpentMinor: 0, spentMinor: 1200_00 });
    expect(computeMonthSummary({ ...input, month: '2026-09' }))
      .toMatchObject({ billScheduledMinor: 399_00, billUpcomingMinor: 399_00, fixedSpentMinor: 0 });
    expect(computeMonthSummary(input)).toEqual(computeMonthSummary({ ...input, fixedPayments: [{ ...payment }] }));
  });

  it('keeps fixed and MSI components separate when a cuota moves from committed to spent', () => {
    const installments = [{ index: 1, month: '2026-08', amountMinor: 100_00, status: 'committed' as const }];
    const msi = { id: 'msi', amountMinor: 300_00, status: 'accepted', currency: 'MXN', receivedAt: charge.receivedAt,
      msi: { months: 3, principalMinor: 300_00, cuotaMinor: 100_00, installments } };
    const before = computeMonthSummary({ ...input, events: [...input.events, msi] });
    const after = computeMonthSummary({ ...input, events: [...input.events,
      { ...msi, msi: { ...msi.msi, installments: [{ ...installments[0]!, status: 'spent' }] } }] });
    expect(before).toMatchObject({ fixedSpentMinor: 200_00, billUpcomingMinor: 0, msiCommittedMinor: 100_00, remainingMinor: 8700_00 });
    expect(after).toMatchObject({ fixedSpentMinor: 200_00, billUpcomingMinor: 0, msiSpentMinor: 100_00, msiCommittedMinor: 0,
      remainingMinor: before.remainingMinor, projectedSpendMinor: before.projectedSpendMinor });
  });

  it('rejects a duplicate explicit relationship instead of subtracting the same observed charge twice', () => {
    expect(() => computeMonthSummary({ ...input, fixedPayments: [payment, { ...payment, id: 'second-service' }] }))
      .toThrow('A charge cannot cover more than one fixed payment');
  });

  it('does not pace past or future months and keeps historical Gastaste equal to recorded spend', () => {
    expect(computeMonthSummary({ ...input, now: new Date('2026-09-05T18:00:00Z') }))
      .toMatchObject({ isCurrentMonth: false, isFutureMonth: false, projectedSpendMinor: 1200_00 });
    expect(computeMonthSummary({ ...input, now: new Date('2026-07-05T18:00:00Z') }))
      .toMatchObject({ isCurrentMonth: false, isFutureMonth: true, projectedSpendMinor: 1200_00 });
  });
});

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

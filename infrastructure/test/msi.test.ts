import { describe, expect, it } from 'vitest';
import {
  AMEX_AUTO_MSI_THRESHOLD_MINOR,
  amountsWithinTolerance,
  buildMsiSchedule,
  computeMonthSummary,
  markInstallmentSpent,
  maybeAutoAmexMsi,
  msiLabel,
} from '@finance/domain';

describe('msi schedule', () => {
  it('builds committed installments across months', () => {
    const plan = buildMsiSchedule({
      principalMinor: 9_000_00,
      months: 3,
      startMonth: '2026-08',
      origin: 'manual',
    });
    expect(plan.cuotaMinor).toBe(3_000_00);
    expect(plan.installments.map((item) => item.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(plan.installments.every((item) => item.status === 'committed')).toBe(true);
  });

  it('auto-tags Amex only above the threshold', () => {
    expect(maybeAutoAmexMsi({
      institution: 'american_express_mx',
      amountMinor: AMEX_AUTO_MSI_THRESHOLD_MINOR,
      receivedAt: '2026-08-01T12:00:00Z',
    })).toBeUndefined();
    const plan = maybeAutoAmexMsi({
      institution: 'american_express_mx',
      amountMinor: AMEX_AUTO_MSI_THRESHOLD_MINOR + 1,
      receivedAt: '2026-08-01T12:00:00Z',
    });
    expect(plan?.months).toBe(3);
    expect(plan?.origin).toBe('amex_auto');
  });

  it('uses statement amount when marking spent', () => {
    const plan = buildMsiSchedule({
      principalMinor: 9_000_00,
      months: 3,
      startMonth: '2026-08',
      origin: 'amex_auto',
    });
    const updated = markInstallmentSpent(plan, 1, {
      amountMinor: 3_001_00,
      confirmedAt: '2026-08-15T12:00:00Z',
      evidenceObservationId: 'obs-1',
    });
    expect(updated.installments[0]?.status).toBe('spent');
    expect(updated.installments[0]?.amountMinor).toBe(3_001_00);
    expect(updated.cuotaMinor).toBe(3_001_00);
    expect(amountsWithinTolerance(3_000_00, 3_001_00)).toBe(true);
  });
});

describe('computeMonthSummary with MSI', () => {
  const now = new Date('2026-08-02T14:00:00-06:00');

  it('counts only spent MSI cuotas and keeps committed separate', () => {
    const plan = buildMsiSchedule({
      principalMinor: 9_000_00,
      months: 3,
      startMonth: '2026-08',
      origin: 'manual',
      cuotaMinor: 3_000_00,
    });
    const spentPlan = markInstallmentSpent(plan, 1, {
      amountMinor: 3_000_00,
      confirmedAt: '2026-08-10T12:00:00Z',
    });

    const beforeEvidence = computeMonthSummary({
      events: [{
        amountMinor: 9_000_00,
        status: 'accepted',
        merchantRaw: 'Liverpool',
        receivedAt: '2026-08-01T12:00:00Z',
        msi: plan,
      }],
      month: '2026-08',
      incomeMinor: 50_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 1_000_00,
      now,
    });
    expect(beforeEvidence.spentMinor).toBe(0);
    expect(beforeEvidence.msiCommittedMinor).toBe(3_000_00);
    expect(beforeEvidence.upcomingMinor).toBe(4_000_00);
    expect(beforeEvidence.committedMsiRows[0]?.name).toBe(msiLabel('Liverpool', { index: 1 }, 3));

    const afterEvidence = computeMonthSummary({
      events: [{
        amountMinor: 9_000_00,
        status: 'accepted',
        merchantRaw: 'Liverpool',
        receivedAt: '2026-08-01T12:00:00Z',
        msi: spentPlan,
      }],
      month: '2026-08',
      incomeMinor: 50_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 1_000_00,
      now,
    });
    expect(afterEvidence.spentMinor).toBe(3_000_00);
    expect(afterEvidence.msiCommittedMinor).toBe(0);
    expect(afterEvidence.remainingMinor).toBe(50_000_00 - 3_000_00 - 1_000_00);
  });

  it('paces only discretionary spend', () => {
    const plan = markInstallmentSpent(buildMsiSchedule({
      principalMinor: 3_000_00,
      months: 3,
      startMonth: '2026-08',
      origin: 'manual',
    }), 1, { amountMinor: 1_000_00, confirmedAt: '2026-08-01T12:00:00Z' });

    const summary = computeMonthSummary({
      events: [
        { amountMinor: 2_000_00, status: 'accepted', receivedAt: '2026-08-01T12:00:00Z' },
        {
          amountMinor: 3_000_00,
          status: 'accepted',
          merchantRaw: 'Amazon',
          receivedAt: '2026-08-01T13:00:00Z',
          msi: plan,
        },
      ],
      month: '2026-08',
      incomeMinor: 100_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now,
    });

    expect(summary.discretionarySpentMinor).toBe(2_000_00);
    expect(summary.msiSpentMinor).toBe(1_000_00);
    expect(summary.spentMinor).toBe(3_000_00);
    const paced = Math.round((2_000_00 / 2) * 31);
    expect(summary.projectedRemainingMinor).toBe(100_000_00 - (paced + 1_000_00));
  });

  it('ignores committed installments on incomplete statement stubs', () => {
    const stub = {
      ...buildMsiSchedule({
        principalMinor: 9_000_00,
        months: 3,
        startMonth: '2026-07',
        origin: 'statement_unplanned',
        cuotaMinor: 3_000_00,
        needsScheduleCompletion: true,
      }),
      needsScheduleCompletion: true as const,
    };
    const summary = computeMonthSummary({
      events: [{
        amountMinor: 9_000_00,
        status: 'needs_review',
        merchantRaw: 'Amazon a meses',
        receivedAt: '2026-07-15T12:00:00Z',
        occurredAt: '2026-07-15T12:00:00Z',
        msi: stub,
      }],
      month: '2026-08',
      incomeMinor: 50_000_00,
      incomeConfigured: true,
      upcomingPaymentsMinor: 0,
      now,
    });
    expect(summary.msiCommittedMinor).toBe(0);
    expect(summary.committedMsiRows).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildMsiSchedule, markInstallmentSpent, replaceMsiSchedule } from '@finance/domain';
import { matchEvidenceLine } from '../src/imports/msi-reconciliation.js';

describe('matchEvidenceLine', () => {
  it('confirms an Amex automatic MSI cuota by principal and index', () => {
    const plan = buildMsiSchedule({
      principalMinor: 674_900,
      months: 3,
      startMonth: '2026-06',
      origin: 'amex_auto',
      cuotaMinor: 224_967,
    });
    const match = matchEvidenceLine(
      {
        merchantRaw: 'MESES EN AUTOMÁTICO NACIONAL',
        amountMinor: 224_967,
        occurredOn: '2026-07-06',
        installmentIndex: 2,
        installmentMonths: 3,
        originalAmountMinor: 674_900,
        identity: 'amex-plan-1',
      },
      [{ id: 'evt-1', merchantRaw: 'SOME STORE', status: 'accepted', msi: plan }],
    );
    expect(match.kind).toBe('confirm');
    if (match.kind === 'confirm') {
      expect(match.eventId).toBe('evt-1');
      expect(match.next.installments[1]?.status).toBe('spent');
      expect(match.next.installments[1]?.amountMinor).toBe(224_967);
    }
  });

  it('does not match automatic Amex labels without original principal', () => {
    const plan = buildMsiSchedule({
      principalMinor: 674_900,
      months: 3,
      startMonth: '2026-06',
      origin: 'amex_auto',
      cuotaMinor: 224_967,
    });
    const match = matchEvidenceLine(
      {
        merchantRaw: 'MESES EN AUTOMÁTICO NACIONAL',
        amountMinor: 224_967,
        occurredOn: '2026-07-06',
        installmentIndex: 2,
        installmentMonths: 3,
        identity: 'amex-plan-no-principal',
      },
      [{ id: 'evt-1', merchantRaw: 'SOME STORE', status: 'accepted', msi: plan }],
    );
    expect(match.kind).toBe('needs_decision');
  });

  it('returns needs_decision for ambiguous automatic Amex matches', () => {
    const left = buildMsiSchedule({
      principalMinor: 600_000,
      months: 3,
      startMonth: '2026-06',
      origin: 'amex_auto',
      cuotaMinor: 200_000,
    });
    const right = buildMsiSchedule({
      principalMinor: 600_000,
      months: 3,
      startMonth: '2026-06',
      origin: 'amex_auto',
      cuotaMinor: 200_000,
    });
    const match = matchEvidenceLine(
      {
        merchantRaw: 'MESES EN AUTOMÁTICO NACIONAL',
        amountMinor: 200_000,
        occurredOn: '2026-07-06',
        installmentIndex: 2,
        installmentMonths: 3,
        originalAmountMinor: 600_000,
        identity: 'amex-ambiguous',
      },
      [
        { id: 'evt-1', merchantRaw: 'STORE A', status: 'accepted', msi: left },
        { id: 'evt-2', merchantRaw: 'STORE B', status: 'accepted', msi: right },
      ],
    );
    expect(match.kind).toBe('needs_decision');
    if (match.kind === 'needs_decision') {
      expect(match.reason).toBe('ambiguous_msi_match');
      expect(match.candidates).toHaveLength(2);
    }
  });

  it('skips evidence already confirmed by observation id', () => {
    const plan = markInstallmentSpent(
      buildMsiSchedule({
        principalMinor: 674_900,
        months: 3,
        startMonth: '2026-06',
        origin: 'amex_auto',
        cuotaMinor: 224_967,
      }),
      2,
      {
        amountMinor: 224_967,
        confirmedAt: '2026-07-10T12:00:00Z',
        evidenceObservationId: 'amex-plan-1',
      },
    );
    const match = matchEvidenceLine(
      {
        merchantRaw: 'MESES EN AUTOMÁTICO NACIONAL',
        amountMinor: 224_967,
        occurredOn: '2026-07-06',
        installmentIndex: 2,
        installmentMonths: 3,
        originalAmountMinor: 674_900,
        identity: 'amex-plan-1',
      },
      [{ id: 'evt-1', merchantRaw: 'SOME STORE', status: 'accepted', msi: plan }],
    );
    expect(match).toEqual({ kind: 'skip', reason: 'already_confirmed' });
  });

  it('requires a decision when a statement cuota has no matching plan', () => {
    const match = matchEvidenceLine(
      {
        merchantRaw: 'AEROMEXICO 8697744',
        amountMinor: 150_867,
        occurredOn: '2026-06-23',
        installmentIndex: 2,
        installmentMonths: 3,
        originalAmountMinor: 452_600,
        identity: 'amex-plan-2',
      },
      [],
    );
    expect(match).toEqual({ kind: 'needs_decision', reason: 'no_matching_plan', candidates: [] });
  });

  it('confirms by merchant+principal when calendar months drifted from a mid-plan create', () => {
    // Plan opened from 2/3 on June 23 → start May. Later import of 1/3 must not spawn a duplicate.
    const plan = markInstallmentSpent(
      buildMsiSchedule({
        principalMinor: 452_600,
        months: 3,
        startMonth: '2026-05',
        origin: 'manual',
        cuotaMinor: 150_867,
      }),
      2,
      {
        amountMinor: 150_867,
        confirmedAt: '2026-06-23T12:00:00Z',
        evidenceObservationId: 'amex-2-of-3',
      },
    );
    const withPriorSpent = {
      ...plan,
      installments: plan.installments.map((installment) =>
        installment.index === 1 ? { ...installment, status: 'spent' as const } : installment,
      ),
    };
    const match = matchEvidenceLine(
      {
        merchantRaw: 'AEROMEXICO 8697744 NUEVO PORTAL',
        amountMinor: 150_867,
        occurredOn: '2026-06-04',
        installmentIndex: 1,
        installmentMonths: 3,
        originalAmountMinor: 452_600,
        identity: 'amex-1-of-3',
      },
      [{ id: 'evt-aero', merchantRaw: 'AEROMEXICO 8697744 NUEVO PORTAL', status: 'accepted', msi: withPriorSpent }],
    );
    expect(match.kind).toBe('confirm');
    if (match.kind === 'confirm') {
      expect(match.eventId).toBe('evt-aero');
      expect(match.installmentIndex).toBe(1);
      expect(match.next.installments[0]?.evidenceObservationId).toBe('amex-1-of-3');
    }
  });

  it('confirms Santander AMAZON by principal across statement months', () => {
    const plan = markInstallmentSpent(
      buildMsiSchedule({
        principalMinor: 285_500,
        months: 12,
        startMonth: '2026-05',
        origin: 'manual',
        cuotaMinor: 23_792,
      }),
      3,
      {
        amountMinor: 23_792,
        confirmedAt: '2026-07-03T12:00:00Z',
        evidenceObservationId: 'san-3-of-12',
      },
    );
    const withPriors = {
      ...plan,
      installments: plan.installments.map((installment) =>
        installment.index < 3 ? { ...installment, status: 'spent' as const } : installment,
      ),
    };
    const match = matchEvidenceLine(
      {
        merchantRaw: 'AMAZON A MESES',
        amountMinor: 23_792,
        occurredOn: '2026-05-04',
        installmentIndex: 1,
        installmentMonths: 12,
        originalAmountMinor: 285_500,
        identity: 'san-1-of-12',
      },
      [{ id: 'evt-amz', merchantRaw: 'AMAZON A MESES', status: 'accepted', msi: withPriors }],
    );
    expect(match.kind).toBe('confirm');
    if (match.kind === 'confirm') {
      expect(match.eventId).toBe('evt-amz');
      expect(match.installmentIndex).toBe(1);
    }
  });
});

describe('replaceMsiSchedule', () => {
  it('preserves spent installments when the schedule is edited', () => {
    const previous = markInstallmentSpent(
      buildMsiSchedule({
        principalMinor: 9_000_00,
        months: 3,
        startMonth: '2026-06',
        origin: 'manual',
        cuotaMinor: 3_000_00,
      }),
      1,
      { amountMinor: 3_001_00, confirmedAt: '2026-06-15T12:00:00Z', evidenceObservationId: 'obs-1' },
    );
    const next = replaceMsiSchedule(previous, {
      principalMinor: 9_000_00,
      months: 3,
      startMonth: '2026-06',
      origin: 'manual',
      cuotaMinor: 3_000_00,
    });
    expect(next.installments[0]).toMatchObject({
      status: 'spent',
      amountMinor: 3_001_00,
      evidenceObservationId: 'obs-1',
    });
    expect(next.installments[1]?.status).toBe('committed');
  });
});

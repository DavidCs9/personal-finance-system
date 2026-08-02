import { describe, expect, it } from 'vitest';
import { buildMsiSchedule, markInstallmentSpent, replaceMsiSchedule } from '@finance/domain';
import { matchEvidenceLine } from '../lambda/msi-reconciliation.js';

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
    expect(match.kind).not.toBe('confirm');
  });

  it('skips ambiguous automatic Amex matches with the same cuota shape', () => {
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
    expect(match).toEqual({ kind: 'skip', reason: 'ambiguous_msi_match' });
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

  it('creates an unplanned MSI stub for unmatched statement cuotas', () => {
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
    expect(match.kind).toBe('unplanned');
    if (match.kind === 'unplanned') {
      expect(match.plan.needsScheduleCompletion).toBe(true);
      expect(match.plan.installments.some((item) => item.status === 'spent')).toBe(true);
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

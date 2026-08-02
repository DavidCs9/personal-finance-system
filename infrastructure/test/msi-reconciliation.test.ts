import { describe, expect, it } from 'vitest';
import { buildMsiSchedule } from '@finance/domain';
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

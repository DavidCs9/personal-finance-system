import { describe, expect, it } from 'vitest';
import {
  classifyPurchaseCharge,
  statementMsiApplyAction,
  statementPreviewSummary,
  statementPurchaseApplyAction,
} from '../lambda/statement-reconciliation.js';
import { buildPlanFromCreateDecision } from '../lambda/msi-reconciliation.js';

describe('classifyPurchaseCharge', () => {
  it('marks unique merchant/date/amount matches as matched', () => {
    const row = classifyPurchaseCharge({
      provider: 'amex',
      accountLastFour: '1007',
      institution: 'american_express_mx',
      charge: {
        identity: 'a1',
        merchantRaw: 'COSTCO CHIHUAHUA',
        amountMinor: 105_705,
        occurredOn: '2026-06-22',
      },
      events: [{
        id: 'evt-1',
        institution: 'american_express_mx',
        status: 'accepted',
        account: { lastFour: '1007' },
        amount: { amountMinor: 105_705, currency: 'MXN' },
        merchantRaw: 'COSTCO CHIHUAHUA DF',
        occurredAt: '2026-06-22T18:00:00.000Z',
      }],
      claimed: new Set(),
      localDate: (value) => String(value).slice(0, 10),
    });
    expect(row).toMatchObject({ kind: 'purchase', status: 'matched', eventId: 'evt-1' });
  });

  it('marks zero candidates as new and credits as excluded', () => {
    const neu = classifyPurchaseCharge({
      provider: 'santander',
      accountLastFour: '6349',
      institution: 'santander_mx',
      charge: {
        identity: 's1',
        merchantRaw: 'MANGO',
        amountMinor: 302_600,
        occurredOn: '2026-06-15',
      },
      events: [],
      claimed: new Set(),
      localDate: () => undefined,
    });
    expect(neu.status).toBe('new');
    const credit = classifyPurchaseCharge({
      provider: 'santander',
      accountLastFour: '6349',
      institution: 'santander_mx',
      charge: {
        identity: 's2',
        merchantRaw: 'PAGO',
        amountMinor: 1000,
        occurredOn: '2026-06-15',
        credit: true,
      },
      events: [],
      claimed: new Set(),
      localDate: () => undefined,
    });
    expect(credit.status).toBe('excluded');
  });
});

describe('statementPurchaseApplyAction', () => {
  it('creates new rows and links stable matches', () => {
    const neu = {
      identity: '1',
      kind: 'purchase' as const,
      merchantRaw: 'X',
      amountMinor: 100,
      occurredOn: '2026-01-01',
      status: 'new' as const,
      candidateEventIds: [],
      candidates: [],
    };
    expect(statementPurchaseApplyAction(neu, neu)).toEqual({ kind: 'create' });
    const matched = {
      ...neu,
      status: 'matched' as const,
      candidateEventIds: ['e1'],
      eventId: 'e1',
    };
    expect(statementPurchaseApplyAction(matched, matched)).toEqual({ kind: 'link', eventId: 'e1' });
  });
});

describe('statementPreviewSummary', () => {
  it('counts purchase and msi buckets', () => {
    const summary = statementPreviewSummary([
      {
        identity: 'p',
        kind: 'purchase',
        merchantRaw: 'A',
        amountMinor: 1,
        occurredOn: '2026-01-01',
        status: 'new',
        candidateEventIds: [],
        candidates: [],
      },
      {
        identity: 'm',
        kind: 'msi',
        merchantRaw: 'B',
        amountMinor: 2,
        occurredOn: '2026-01-01',
        status: 'needs_decision',
        candidateEventIds: [],
        candidates: [],
        msi: true,
      },
    ]);
    expect(summary).toMatchObject({ total: 2, new: 1, needsDecision: 1, unplanned: 1, purchases: 1, msi: 1 });
  });
});

describe('statementMsiApplyAction', () => {
  const needsDecisionRow = {
    identity: 'm1',
    kind: 'msi' as const,
    merchantRaw: 'AMAZON A MESES',
    amountMinor: 50_000,
    occurredOn: '2026-07-15',
    status: 'needs_decision' as const,
    candidateEventIds: [] as string[],
    candidates: [],
    msi: true,
  };

  it('requires create_plan or skip for unmatched MSI', () => {
    expect(statementMsiApplyAction(needsDecisionRow, needsDecisionRow)).toEqual({ kind: 'skip' });
    expect(statementMsiApplyAction(needsDecisionRow, needsDecisionRow, { action: 'skip' })).toEqual({ kind: 'skip' });
    expect(statementMsiApplyAction(needsDecisionRow, needsDecisionRow, {
      action: 'create_plan',
      months: 3,
      cuotaMinor: 50_000,
    })).toEqual({ kind: 'create_plan', months: 3, cuotaMinor: 50_000 });
  });

  it('auto-confirms matched MSI rows', () => {
    const matched = { ...needsDecisionRow, status: 'matched' as const, eventId: 'evt-1', candidateEventIds: ['evt-1'] };
    expect(statementMsiApplyAction(matched, matched)).toEqual({ kind: 'confirm_msi', eventId: 'evt-1' });
  });
});

describe('buildPlanFromCreateDecision', () => {
  it('builds a complete manual schedule with the evidenced cuota spent', () => {
    const plan = buildPlanFromCreateDecision(
      {
        merchantRaw: 'AMAZON A MESES',
        amountMinor: 50_018,
        occurredOn: '2026-07-15',
        installmentIndex: 2,
        installmentMonths: 3,
        identity: 'msi-1',
      },
      { months: 3, cuotaMinor: 50_000 },
    );
    expect(plan.origin).toBe('manual');
    expect(plan.needsScheduleCompletion).toBeUndefined();
    expect(plan.installments[1]?.status).toBe('spent');
    expect(plan.installments[0]?.status).toBe('committed');
    expect(plan.installments[2]?.status).toBe('committed');
  });
});

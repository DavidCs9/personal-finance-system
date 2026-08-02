import { describe, expect, it } from 'vitest';
import {
  classifyPurchaseCharge,
  statementPreviewSummary,
  statementPurchaseApplyAction,
} from '../lambda/statement-reconciliation.js';

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
        status: 'unplanned',
        candidateEventIds: [],
        candidates: [],
        msi: true,
      },
    ]);
    expect(summary).toMatchObject({ total: 2, new: 1, unplanned: 1, purchases: 1, msi: 1 });
  });
});

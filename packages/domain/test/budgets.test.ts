import { describe, it, expect } from 'vitest';
import { BUDGET_EXCLUSION_TAG, computeBudgetStatus, proposeBudget, type BudgetExclusion, type BudgetSpendEvent, type SpendingBudget } from '../src/budgets.js';
const now = new Date('2026-11-15T18:00:00Z');
const budget = proposeBudget({ action: 'set_recurring', month: '2026-11', totalMxnMinor: 10000,
  allocations: [{ categoryId: 'food', amountMxnMinor: 6000 }] }, null, 'id', now.toISOString()) as SpendingBudget;
const event = (id: string, amountMinor: number, extra: Partial<BudgetSpendEvent> = {}): BudgetSpendEvent => ({ id, amountMinor, currency: 'MXN', status: 'accepted',
  occurredAt: '2026-11-15T18:00:00Z', receivedAt: '2026-11-15T18:00:00Z', categoryId: 'food', ...extra });
const status = (events: BudgetSpendEvent[], extra = {}) => computeBudgetStatus({ month: '2026-11', budget, now, events, fixedPayments: [], exclusions: [], ...extra });
describe('deterministic budgets using canonical accounting', () => {
  it('reconciles allocations, transfers without raising total, and blocks historical edits', () => {
    expect(() => proposeBudget({ action: 'set_recurring', totalMxnMinor: 5999, expectedRevision: 1 }, budget, 'id', now.toISOString())).toThrow(/exceden/);
    const next = proposeBudget({ action: 'reallocate', expectedRevision: 1, fromCategoryId: 'food', toCategoryId: 'fun', amountMxnMinor: 1000 }, budget, 'id', now.toISOString()) as SpendingBudget;
    expect(next).toMatchObject({ totalMxnMinor: 10000, allocations: [{ categoryId: 'food', amountMxnMinor: 5000 }, { categoryId: 'fun', amountMxnMinor: 1000 }] });
    expect(() => proposeBudget({ action: 'archive', expectedRevision: 1 }, budget, 'id', '2026-12-01T18:00:00Z')).toThrow(/cerrados/);
  });
  it('counts personal spend, MSI cuotas and fixed charges once and reserves remaining commitments', () => {
    const msi = { months: 2, principalMinor: 8000, cuotaMinor: 4000, installments: [
      { index: 1, month: '2026-11', amountMinor: 4000, status: 'spent' as const }, { index: 2, month: '2026-12', amountMinor: 4000, status: 'committed' as const }] };
    const result = status([event('msi', 8000, { msi }), event('fixed', 3000, { personalAmountMinor: 1000 }), event('rejected', 100000, { status: 'rejected' }),
      event('foreign', 9999, { status: 'pending_foreign' })], { fixedPayments: [{ id: 'bill', amountMinor: 3000, reconciliation: { eventId: 'fixed', valid: true } }, { id: 'due', amountMinor: 1000 }] });
    expect(result).toMatchObject({ grossSpentMxnMinor: 5000, countedSpentMxnMinor: 5000, upcomingCommitmentsMxnMinor: 1000,
      remainingMxnMinor: 5000, remainingDiscretionaryMxnMinor: 4000, safeDailyAllowanceMxnMinor: 250,
      categories: [{ countedSpentMxnMinor: 5000 }], unallocatedMxnMinor: 4000 });
  });
  it('excludes explicit extraordinary charge and its effective fixed occurrence without changing gross spend', () => {
    expect(status([event('extra', 3000)], { fixedPayments: [{ id: 'bill', amountMinor: 5000, reconciliation: { eventId: 'extra', valid: true } }],
      exclusions: [{ entityType: 'exclusion', id: 'x', month: '2026-11', movementId: 'extra', reason: 'Travel', status: 'active', revision: 1, createdAt: '', updatedAt: '' }] }))
      .toMatchObject({ grossSpentMxnMinor: 3000, countedSpentMxnMinor: 0, excludedSpentMxnMinor: 3000, upcomingCommitmentsMxnMinor: 0 });
  });
  it('applies and reverses the exact budget tag while preserving manual exclusions, gross spend and fixed links', () => {
    const charge = event('charge', 3000, { personalAmountMinor: 2500 });
    const tagged = { ...charge, tags: [BUDGET_EXCLUSION_TAG] };
    const unrelated = event('unrelated', 1000, { tags: ['presupuesto:excluir-otro'] });
    const manual: BudgetExclusion = { entityType: 'exclusion', id: 'manual', month: '2026-11', movementId: charge.id,
      reason: 'Viaje', status: 'active', revision: 1, createdAt: '', updatedAt: '' };
    const options = { includeSpendTimeline: true, fixedPayments: [
      { id: 'bill', amountMinor: 5000, reconciliation: { eventId: charge.id, valid: true } },
    ] };
    const excluded = status([tagged, unrelated], options);
    expect(excluded).toMatchObject({ grossSpentMxnMinor: 3500, countedSpentMxnMinor: 1000, excludedSpentMxnMinor: 2500,
      upcomingCommitmentsMxnMinor: 0, tagExcludedMovementIds: [charge.id],
      categories: [{ grossSpentMxnMinor: 3500, countedSpentMxnMinor: 1000 }] });
    expect(excluded.spendTimeline?.cumulativeMinorByDay.at(-1)).toBe(1000);
    for (const movement of [tagged, charge]) {
      expect(status([movement, unrelated], { ...options, exclusions: [manual] }))
        .toMatchObject({ countedSpentMxnMinor: 1000, excludedSpentMxnMinor: 2500, tagExcludedMovementIds: [], exclusions: [manual] });
    }
    expect(status([tagged], { exclusions: [{ ...manual, status: 'archived' }] }))
      .toMatchObject({ countedSpentMxnMinor: 0, tagExcludedMovementIds: [charge.id] });
    expect(status([charge, unrelated], options))
      .toMatchObject({ grossSpentMxnMinor: 3500, countedSpentMxnMinor: 3500, countedFixedSpendMxnMinor: 2500, excludedSpentMxnMinor: 0 });
  });
  it('excludes tagged MSI cuotas and commitments in their months while retaining recorded spend', () => {
    const purchase = event('msi', 8000, { msi: { months: 2, principalMinor: 8000, cuotaMinor: 4000, installments: [
      { index: 1, month: '2026-11', amountMinor: 4000, status: 'spent' },
      { index: 2, month: '2026-12', amountMinor: 4000, status: 'committed' },
    ] } });
    const tagged = { ...purchase, tags: [BUDGET_EXCLUSION_TAG] };
    expect(status([tagged])).toMatchObject({ grossSpentMxnMinor: 4000, countedSpentMxnMinor: 0, excludedSpentMxnMinor: 4000 });
    expect(status([tagged], { month: '2026-12' })).toMatchObject({ grossSpentMxnMinor: 0, upcomingMsiMxnMinor: 0, tagExcludedMovementIds: ['msi'] });
    expect(status([purchase], { month: '2026-12' })).toMatchObject({ upcomingMsiMxnMinor: 4000 });
  });
  it('reports warnings, zero limits, month boundaries, unknown schedules and uncategorized spending honestly', () => {
    for (const [amount, warning] of [[7000, '70'], [9000, '90'], [10000, '100'], [11000, '100']] as const) expect(status([event('x', amount)]).warning).toBe(warning);
    expect(status([event('x', 11000, { categoryId: null })])).toMatchObject({ remainingMxnMinor: -1000, overspentMxnMinor: 1000,
      categories: expect.arrayContaining([expect.objectContaining({ categoryId: null, limitMxnMinor: 0, overspentMxnMinor: 11000 })]) });
    expect(status([], { additionalIncompleteMovementIds: ['prior-purchase-with-unknown-schedule'] })).toMatchObject({ safeDailyAllowanceMxnMinor: null });
    expect(status([], { month: '2026-12' })).toMatchObject({ elapsedPercent: 0, remainingDays: 31 });
    expect(status([], { month: '2026-10' })).toMatchObject({ elapsedPercent: 100, remainingDays: 0, safeDailyAllowanceMxnMinor: null });
    expect(status([event('x', 1000, { msi: { months: 2, principalMinor: 2000, cuotaMinor: 1000, installments: [], needsScheduleCompletion: true } })]))
      .toMatchObject({ incompleteScheduleMovementIds: ['x'], safeDailyAllowanceMxnMinor: null });
  });
  it('keeps recorded cuotas without a bank day in the total while comparing dated counted spend to the monthly limit', () => {
    const msi = { months: 2, principalMinor: 4200, cuotaMinor: 2100, installments: [
      { index: 1, month: '2026-11', amountMinor: 2100, status: 'spent' as const },
      { index: 2, month: '2026-12', amountMinor: 2100, status: 'committed' as const },
    ] };
    const result = status([
      event('personal', 9000, { personalAmountMinor: 4000, occurredAt: '2026-11-07T03:00:00Z' }),
      event('undated-cuota', 4200, { msi }),
      event('excluded', 900),
      event('usd', 40000, { currency: 'USD' }),
    ], {
      includeSpendTimeline: true, fixedPayments: [{ id: 'due', amountMinor: 3000 }],
      exclusions: [{ entityType: 'exclusion', id: 'x', month: '2026-11', movementId: 'excluded',
        reason: 'Extraordinary', status: 'active', revision: 1, createdAt: '', updatedAt: '' }],
    });
    expect(result).toMatchObject({ countedSpentMxnMinor: 6100, warning: 'normal', warningWithCommitments: '90',
      utilizationWithCommitmentsPercent: 91, remainingDiscretionaryMxnMinor: 900, paceVarianceMxnMinor: 1100,
      spendTimeline: { unplottedMinor: 2100, unplottedEntries: 1 } });
    expect(result.spendTimeline?.cumulativeMinorByDay.slice(5, 8)).toEqual([0, 4000, 4000]);
    expect(result.spendTimeline?.cumulativeMinorByDay.at(-1)).toBe(4000);
  });
});

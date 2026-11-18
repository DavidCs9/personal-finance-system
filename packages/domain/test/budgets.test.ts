import { describe, it, expect } from 'vitest';
import { computeBudgetStatus, proposeBudget, type BudgetSpendEvent, type SpendingBudget } from '../src/budgets.js';
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
});

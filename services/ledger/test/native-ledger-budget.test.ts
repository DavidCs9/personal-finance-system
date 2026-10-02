import { describe, expect, it } from 'vitest';
import { ledgerMutationBudgetActive, LedgerMutationBudgetError, reserveLedgerMutations,
  withLedgerMutationBudget } from '../src/dsql/ledger-budget.js';

describe('apply-local ledger mutation budget', () => {
  it('reserves the barrier, preserves a nested budget and clears context after a rejected operation', async () => {
    expect(ledgerMutationBudgetActive()).toBe(false);
    await expect(withLedgerMutationBudget(async () => {
      reserveLedgerMutations(2999);
      await withLedgerMutationBudget(async () => { reserveLedgerMutations(1); });
    })).rejects.toBeInstanceOf(LedgerMutationBudgetError);
    expect(ledgerMutationBudgetActive()).toBe(false);
    await withLedgerMutationBudget(async () => { reserveLedgerMutations(2999); });
    expect(ledgerMutationBudgetActive()).toBe(false);
  });
  it('isolates independent concurrent attempts without carrying failed reservations into another callback', async () => {
    await Promise.all([0, 1].map(() => withLedgerMutationBudget(async () => {
      reserveLedgerMutations(2000); await Promise.resolve(); reserveLedgerMutations(999);
      expect(() => reserveLedgerMutations(1)).toThrow(LedgerMutationBudgetError);
    })));
    expect(ledgerMutationBudgetActive()).toBe(false);
    await withLedgerMutationBudget(async () => {
      expect(() => reserveLedgerMutations(-1)).toThrow('Invalid ledger mutation reservation');
      reserveLedgerMutations(2999);
    });
  });
});

import { AsyncLocalStorage } from 'node:async_hooks';

export class LedgerMutationBudgetError extends Error {}
const context = new AsyncLocalStorage<{ mutations: number }>();

/** Apply-local validation only; the provider still owns transactions, limits, rollback and OCC retry. */
export const withLedgerMutationBudget = <T>(callback: () => Promise<T>): Promise<T> => {
  if (context.getStore()) return callback();
  // The native transaction updates its activation barrier before entering the apply callback.
  return context.run({ mutations: 1 }, callback);
};
export const ledgerMutationBudgetActive = () => context.getStore() !== undefined;
export const reserveLedgerMutations = (rows: number): void => {
  const budget = context.getStore();
  if (!budget) return;
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('Invalid ledger mutation reservation');
  if (budget.mutations + rows > 3000) throw new LedgerMutationBudgetError('Financial import exceeds atomic mutation limit');
  budget.mutations += rows;
};

import { FinancialPlanError } from '@finance/domain';
import { applyFinancialChange, previewFinancialChange } from '../financial-plans/service.js';
import type { FinancialWriteKind } from '@finance/ledger/native-financial-plans';
import { FINANCIAL_WRITE_TOOL_DEFINITIONS } from './financial-tool-definitions.js';
export { FINANCIAL_WRITE_TOOL_DEFINITIONS };
/** Extension point: every registered bounded tool inherits the same trusted Gateway write policy. */
const operations = {
  preview_fixed_reconciliation: { kind: 'fixed_reconciliation', phase: 'preview' }, apply_fixed_reconciliation: { kind: 'fixed_reconciliation', phase: 'apply' },
  preview_msi_reconciliation: { kind: 'msi_reconciliation', phase: 'preview' }, apply_msi_reconciliation: { kind: 'msi_reconciliation', phase: 'apply' },
  preview_budget_change: { kind: 'budget', phase: 'preview' }, apply_budget_change: { kind: 'budget', phase: 'apply' },
  preview_income_change: { kind: 'income', phase: 'preview' }, apply_income_change: { kind: 'income', phase: 'apply' },
  preview_financial_goal_change: { kind: 'goal', phase: 'preview' }, apply_financial_goal_change: { kind: 'goal', phase: 'apply' },
  preview_manual_charge: { kind: 'manual_charge', phase: 'preview' }, apply_manual_charge: { kind: 'manual_charge', phase: 'apply' },
  preview_monthly_received: { kind: 'monthly_received', phase: 'preview' }, apply_monthly_received: { kind: 'monthly_received', phase: 'apply' },
  preview_manual_credit: { kind: 'manual_credit', phase: 'preview' }, apply_manual_credit: { kind: 'manual_credit', phase: 'apply' },
} as const satisfies Record<string, { kind: FinancialWriteKind; phase: 'preview' | 'apply' }>;
export const runFinancialWriteTool = (owner: string, name: string, input: Record<string, unknown>): Promise<unknown> => {
  const operation = operations[name as keyof typeof operations];
  if (!operation) throw new FinancialPlanError('Tool de escritura no soportada.');
  return operation.phase === 'preview' ? previewFinancialChange(owner, operation.kind, input)
    : applyFinancialChange(owner, input.operationId, operation.kind);
};

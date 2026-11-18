import { listBudgets, getBudgetStatus, getBudgetHistory, simulateBudgetPurchase } from '../financial-plans/budgets.js';
import { listExpectedIncome, getExpectedIncome, listFinancialGoals, getFinancialGoal, getFinancialWriteStatus } from '../financial-plans/service.js';
import { getMsiReconciliation } from '../financial-plans/reconciliation.js';
import {
  compareMonths,
  InvalidAgentQueryError,
  investmentHistory,
  listMovementsForAgent,
  monthSnapshot,
  planMonthScenario,
  spendByCategory,
  spendByMerchant,
  wealthSnapshotForAgent,
} from './aggregates.js';
import { TOOL_DEFINITIONS, type AgentToolName } from './tool-definitions.js';
import type { SpendingRange } from './spending-range.js';
import { listAgentCategories } from '../categories/control-plane.js';
import { editOperationStatus } from './edit-status.js';
import { creditCardCyclesForAgent, futureCommitmentsForAgent, monthDetailsForAgent, wealthHistoryForAgent } from './financial-capabilities.js';

export { TOOL_DEFINITIONS, type AgentToolName };

export const runAgentTool = async (
  owner: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name as AgentToolName | string) {
    case 'list_budgets': return listBudgets(owner, input);
    case 'get_budget_status': return getBudgetStatus(owner, input);
    case 'get_budget_history': return getBudgetHistory(owner, input);
    case 'simulate_budget_purchase': return simulateBudgetPurchase(owner, input);
    case 'list_expected_income': return listExpectedIncome(owner, input);
    case 'get_expected_income': return getExpectedIncome(owner, input.incomeId, input);
    case 'list_financial_goals': return listFinancialGoals(owner, input);
    case 'get_financial_goal': return getFinancialGoal(owner, input.goalId);
    case 'get_financial_write_status': return getFinancialWriteStatus(owner, input.operationId);
    case 'get_msi_reconciliation': return getMsiReconciliation(owner, input);
    case 'edit_operation_status':
      return editOperationStatus(owner, input.operationId);
    case 'list_categories':
      return listAgentCategories();
    case 'month_snapshot':
      return monthSnapshot(owner, String(input.month));
    case 'plan_month_scenario':
      return planMonthScenario(owner, input);
    case 'spend_by_category':
      return spendByCategory(String(input.month));
    case 'spend_by_merchant':
      return spendByMerchant(String(input.month), {
        categoryId: typeof input.categoryId === 'string' ? input.categoryId : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
    case 'list_movements':
      return listMovementsForAgent({
        month: typeof input.month === 'string' ? input.month : undefined,
        range: typeof input.range === 'string' ? input.range as SpendingRange : undefined,
        fromDay: typeof input.fromDay === 'string' ? input.fromDay : undefined,
        toDay: typeof input.toDay === 'string' ? input.toDay : undefined,
        categoryId: typeof input.categoryId === 'string' ? input.categoryId : undefined,
        tag: typeof input.tag === 'string' ? input.tag : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      });
    case 'compare_months':
      return compareMonths(
        String(input.month),
        typeof input.against === 'string' ? input.against : undefined,
      );
    case 'wealth_snapshot':
      return wealthSnapshotForAgent(owner);
    case 'get_future_commitments':
      return futureCommitmentsForAgent(owner, input);
    case 'get_month_details':
      return monthDetailsForAgent(owner, input);
    case 'get_credit_card_cycles':
      return creditCardCyclesForAgent(owner);
    case 'get_wealth_history':
      return wealthHistoryForAgent(owner, input);
    case 'investment_history':
      try {
        return await investmentHistory(owner, input);
      } catch (error) {
        if (error instanceof InvalidAgentQueryError) {
          const status = error.code === 'no_data' || error.code === 'ambiguous'
            ? error.code
            : 'invalid';
          return {
            ok: false,
            status,
            reasonCode: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          };
        }
        throw error;
      }
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
};

export const citationsFromToolResult = (
  toolName: string,
  result: unknown,
): readonly { readonly kind: string; readonly id?: string; readonly label: string }[] => {
  if (!result || typeof result !== 'object') return [];
  const data = result as Record<string, unknown>;
  if (toolName === 'list_movements' && Array.isArray(data.movements)) {
    return (data.movements as { id: string; merchantRaw: string }[]).slice(0, 8).map((row) => ({
      kind: 'movement',
      id: row.id,
      label: row.merchantRaw,
    }));
  }
  if (toolName === 'month_snapshot') {
    return [{ kind: 'summary', label: `Resumen ${String(data.month ?? '')}`.trim() }];
  }
  if (toolName === 'plan_month_scenario') {
    return [{ kind: 'summary', label: `Plan ${String(data.month ?? '')}`.trim() }];
  }
  if (toolName === 'wealth_snapshot') {
    return [{ kind: 'wealth', label: 'Patrimonio' }];
  }
  if (toolName === 'investment_history') {
    if (data.ok === false) return [];
    const accountLabel = data.accountId === 'all' ? 'Inversiones · Bitso + IBKR' : String(data.accountId ?? '').toUpperCase();
    return [{
      kind: 'wealth',
      label: [accountLabel, data.symbol ? String(data.symbol) : 'Historial']
        .filter(Boolean)
        .join(' · '),
    }];
  }
  if (toolName === 'spend_by_category' && Array.isArray(data.buckets)) {
    return (data.buckets as { label: string }[]).slice(0, 6).map((bucket) => ({
      kind: 'category',
      label: bucket.label,
    }));
  }
  return [];
};

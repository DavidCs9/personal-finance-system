import {
  compareMonths,
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

export { TOOL_DEFINITIONS, type AgentToolName };

export const runAgentTool = async (
  owner: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name as AgentToolName | string) {
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
      });
    case 'compare_months':
      return compareMonths(
        String(input.month),
        typeof input.against === 'string' ? input.against : undefined,
      );
    case 'wealth_snapshot':
      return wealthSnapshotForAgent(owner);
    case 'investment_history':
      return investmentHistory(owner, input);
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
    return [{
      kind: 'wealth',
      label: [String(data.accountId ?? '').toUpperCase(), data.symbol ? String(data.symbol) : 'Historial']
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

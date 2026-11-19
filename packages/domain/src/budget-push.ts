import type { computeBudgetStatus } from './budgets.js';
import { formatMxnWhole, type PushContentMode } from './month-summary.js';

export type BudgetPushThreshold = 70 | 90 | 100;
export interface BudgetPushAlert {
  readonly scope: string;
  readonly label: string;
  readonly threshold: BudgetPushThreshold;
  readonly marginMinor: number;
  readonly includesCommitments: boolean;
}

type BudgetStatus = ReturnType<typeof computeBudgetStatus>;
type LabeledBudgetStatus = Omit<BudgetStatus, 'categories'> & {
  readonly categories: readonly (BudgetStatus['categories'][number] & { readonly label: string })[];
};

const thresholdOf = (warning: BudgetStatus['warning']): BudgetPushThreshold | null =>
  warning === '70' ? 70 : warning === '90' ? 90 : warning === '100' ? 100 : null;

export const budgetPushAlerts = (status: LabeledBudgetStatus): BudgetPushAlert[] => {
  if (!status.budget || !status.configured) return [];
  const alerts: BudgetPushAlert[] = [];
  const monthThreshold = thresholdOf(status.warningWithCommitments);
  const countedThreshold = thresholdOf(status.warning);
  const { remainingMxnMinor, remainingDiscretionaryMxnMinor } = status;
  if (monthThreshold && remainingMxnMinor !== null && remainingDiscretionaryMxnMinor !== null
    && (status.budget.totalMxnMinor > 0 || remainingDiscretionaryMxnMinor < 0)) {
    const includesCommitments = monthThreshold > (countedThreshold ?? 0);
    alerts.push({ scope: 'total', label: 'Presupuesto mensual', threshold: monthThreshold, includesCommitments,
      marginMinor: includesCommitments ? remainingDiscretionaryMxnMinor : remainingMxnMinor });
  }
  for (const category of status.categories) {
    const threshold = thresholdOf(category.warning);
    if (category.categoryId && category.allocationConfigured && threshold
      && category.limitMxnMinor !== null && category.remainingMxnMinor !== null
      && (category.limitMxnMinor > 0 || category.countedSpentMxnMinor > 0)) {
      alerts.push({ scope: `category:${category.categoryId}`, label: category.label,
        threshold, marginMinor: category.remainingMxnMinor, includesCommitments: false });
    }
  }
  return alerts.sort((a, b) => b.threshold - a.threshold || Number(b.scope === 'total') - Number(a.scope === 'total'));
};

const alertCopy = (alert: BudgetPushAlert): string => {
  const level = alert.threshold < 100 ? `alcanzó el ${alert.threshold}%`
    : alert.marginMinor < 0 ? 'rebasó el límite' : 'alcanzó el límite';
  return `${alert.label} ${level}${alert.includesCommitments ? ' con los compromisos conocidos' : ''}`;
};

export const budgetPushMessage = (month: string, alerts: readonly BudgetPushAlert[], mode: PushContentMode, navigate: string) => {
  const tag = `budget-${month}`;
  if (mode === 'private') return { title: 'Olbia', body: 'Hay avisos de presupuesto en tu Resumen.', tag, navigate };
  const first = alerts[0]!;
  const margin = first.marginMinor < 0 ? ` Exceso de ${formatMxnWhole(-first.marginMinor)}.`
    : first.marginMinor > 0 ? ` Margen de ${formatMxnWhole(first.marginMinor)}.` : '';
  const others = alerts.length - 1;
  const body = others === 0 ? `${alertCopy(first)}.${margin}`
    : `${alerts.slice(0, 2).map(alertCopy).join('. ')}.${others > 1 ? ` Hay ${others - 1} más en Resumen.` : ''}`;
  return { title: 'Olbia · presupuesto', body, tag, navigate };
};

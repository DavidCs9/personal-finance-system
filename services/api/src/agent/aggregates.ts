import {
  aggregateSpendByCategory,
  aggregateSpendByMerchant,
  computeMonthSummary,
  previousCalendarMonth,
  type CategorizedSpendEvent,
  type MonthSummary,
  type SpendAggregateResult,
  type WealthAccountId,
  wealthSnapshotAgeDays,
} from '@finance/domain';
import { getMonthlyPlan } from '../months/service.js';
import { getWealthOverview, listWealthSnapshotsForAccount } from '../wealth/service.js';
import { listCategories } from '../categories/service.js';
import { loadCategorizedMonthEvents, loadCategorizedMonthsEvents } from '../analytics/events.js';
import { isValidMonth } from '../months/monthly-plan.js';
import {
  investmentHistoryFromSnapshots,
  InvalidInvestmentHistoryQueryError,
  portfolioSnapshotsFromAccounts,
  type InvestmentHistoryGranularity,
  type InvestmentHistoryQuery,
  type InvestmentHistoryRange,
} from './investment-history.js';
import {
  InvalidSpendingRangeQueryError,
  resolveSpendingRange,
  spendingRangeFromEvents,
  type SpendingRangeQuery,
} from './spending-range.js';
import { buildMonthScenario, type ScenarioCommitment } from './month-scenario.js';

export class InvalidAgentQueryError extends Error {
  constructor(
    message: string,
    readonly code: string = 'invalid_query',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const investmentAccountId = (value: unknown): WealthAccountId | 'all' => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === 'bitso' || normalized === 'ibkr') return normalized;
  // AgentCore's rendered schema currently drops enum values. Accept the
  // obvious global labels so a natural-language request cannot turn into a
  // misleading Gateway failure when the model supplies one as accountId.
  if (normalized === 'all' || normalized === 'portfolio' || normalized === 'cartera' || normalized === 'inversiones') {
    return 'all';
  }
  throw new InvalidAgentQueryError(
    'La cuenta debe ser Bitso o IBKR. Omítela para consultar todas tus inversiones.',
    'invalid_account',
  );
};

const categoryNameMap = async (): Promise<Map<string, string>> => {
  const categories = await listCategories();
  return new Map(categories.map((category) => [category.id, category.name]));
};

const loadMonthEvents = async (month: string): Promise<CategorizedSpendEvent[]> => {
  if (!isValidMonth(month)) throw new InvalidAgentQueryError('Mes inválido (YYYY-MM).');
  return loadCategorizedMonthEvents(month);
};

const loadRangeEvents = async (months: readonly string[]): Promise<CategorizedSpendEvent[]> => {
  return loadCategorizedMonthsEvents(months);
};

export const monthSnapshot = async (
  owner: string,
  month: string,
  now: Date = new Date(),
): Promise<{
  readonly month: string;
  readonly summary: MonthSummary;
  readonly uncategorizedMinor: number;
  readonly uncategorizedEventCount: number;
}> => {
  const [plan, events, names] = await Promise.all([
    getMonthlyPlan(owner, month),
    loadMonthEvents(month),
    categoryNameMap(),
  ]);
  const upcomingPaymentsMinor = (plan.upcomingPayments as readonly { amountMinor: number }[])
    .reduce((sum, payment) => sum + payment.amountMinor, 0);
  const summary = computeMonthSummary({
    events,
    month,
    incomeMinor: Number(plan.incomeMinor ?? 0),
    incomeConfigured: Boolean(plan.configured),
    upcomingPaymentsMinor,
    now,
  });
  const byCategory = aggregateSpendByCategory(events, month, names);
  return {
    month,
    summary,
    uncategorizedMinor: byCategory.uncategorizedMinor,
    uncategorizedEventCount: byCategory.uncategorizedEventCount,
  };
};

export const planMonthScenario = async (
  owner: string,
  input: Record<string, unknown>,
) => {
  const month = String(input.month);
  const snapshot = await monthSnapshot(owner, month);
  const commitments = Array.isArray(input.commitments)
    ? input.commitments.map((raw) => {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return {
        label: String(item.label ?? ''),
        amount: Number(item.amount),
        currency: String(item.currency) as ScenarioCommitment['currency'],
      };
    })
    : undefined;
  const dailyUsdScenarios = Array.isArray(input.dailyUsdScenarios)
    ? input.dailyUsdScenarios.map(Number)
    : undefined;
  return buildMonthScenario({
    month,
    budgetMxn: Number(input.budgetMxn),
    recordedSpentMxnMinor: snapshot.summary.spentMinor,
    ledgerUpcomingMxnMinor: snapshot.summary.upcomingMinor,
    includeLedgerUpcoming: input.includeLedgerUpcoming === true,
    commitments,
    usdToMxn: input.usdToMxn === undefined ? undefined : Number(input.usdToMxn),
    tripStart: String(input.tripStart),
    tripEnd: String(input.tripEnd),
    dailyUsdScenarios,
  });
};

export const spendByCategory = async (month: string): Promise<SpendAggregateResult> => {
  const [events, names] = await Promise.all([loadMonthEvents(month), categoryNameMap()]);
  return aggregateSpendByCategory(events, month, names);
};

export const spendByMerchant = async (
  month: string,
  options?: { readonly categoryId?: string; readonly limit?: number },
): Promise<SpendAggregateResult> => {
  const events = await loadMonthEvents(month);
  return aggregateSpendByMerchant(events, month, options);
};

export const compareMonths = async (
  month: string,
  againstMonth?: string,
): Promise<{
  readonly month: string;
  readonly againstMonth: string;
  readonly monthTotalMinor: number;
  readonly againstTotalMinor: number;
  readonly deltaMinor: number;
  readonly byCategory: readonly {
    readonly key: string;
    readonly label: string;
    readonly monthMinor: number;
    readonly againstMinor: number;
    readonly deltaMinor: number;
  }[];
}> => {
  const prior = againstMonth ?? previousCalendarMonth(month);
  if (!prior) throw new InvalidAgentQueryError('No hay mes anterior para comparar.');
  const [left, right, names] = await Promise.all([
    loadMonthEvents(month),
    loadMonthEvents(prior),
    categoryNameMap(),
  ]);
  const leftAgg = aggregateSpendByCategory(left, month, names);
  const rightAgg = aggregateSpendByCategory(right, prior, names);
  const keys = new Set([...leftAgg.buckets.map((b) => b.key), ...rightAgg.buckets.map((b) => b.key)]);
  const byCategory = [...keys].map((key) => {
    const a = leftAgg.buckets.find((bucket) => bucket.key === key);
    const b = rightAgg.buckets.find((bucket) => bucket.key === key);
    return {
      key,
      label: a?.label ?? b?.label ?? key,
      monthMinor: a?.amountMinor ?? 0,
      againstMinor: b?.amountMinor ?? 0,
      deltaMinor: (a?.amountMinor ?? 0) - (b?.amountMinor ?? 0),
    };
  }).sort((x, y) => Math.abs(y.deltaMinor) - Math.abs(x.deltaMinor));
  return {
    month,
    againstMonth: prior,
    monthTotalMinor: leftAgg.totalSpentMinor,
    againstTotalMinor: rightAgg.totalSpentMinor,
    deltaMinor: leftAgg.totalSpentMinor - rightAgg.totalSpentMinor,
    byCategory,
  };
};

export const listMovementsForAgent = async (
  query: SpendingRangeQuery,
  now: Date = new Date(),
) => {
  try {
    if (query.limit !== undefined && (!Number.isFinite(query.limit) || query.limit <= 0)) {
      throw new InvalidSpendingRangeQueryError('limit debe ser un número positivo.');
    }
    const range = resolveSpendingRange(query, now);
    const events = range.months.length === 1
      ? await loadMonthEvents(range.months[0]!)
      : await loadRangeEvents(range.months);
    return spendingRangeFromEvents(events, query, now);
  } catch (error) {
    if (error instanceof InvalidSpendingRangeQueryError) {
      throw new InvalidAgentQueryError(error.message);
    }
    throw error;
  }
};

export const wealthSnapshotForAgent = async (owner: string): Promise<Record<string, unknown>> => {
  const wealth = await getWealthOverview(owner);
  return {
    currency: wealth.currency,
    netMxnMinor: wealth.netMxnMinor,
    assetsMxnMinor: wealth.assetsMxnMinor,
    liabilitiesMxnMinor: wealth.liabilitiesMxnMinor,
    accounts: (wealth.accounts as readonly Record<string, unknown>[]).map((account) => ({
      id: account.id,
      name: account.name,
      connected: account.connected,
      latestMxnMinor: (account.latestSnapshot as { totalMxnMinor?: number } | undefined)?.totalMxnMinor ?? null,
    })),
    liabilities: (wealth.liabilities as readonly Record<string, unknown>[]).map((liability) => ({
      cardId: liability.cardId,
      name: liability.name,
      latestMxnMinor: (liability.latestSnapshot as { amountMinor?: number } | undefined)?.amountMinor ?? null,
    })),
  };
};

export const investmentHistory = async (
  owner: string,
  input: Record<string, unknown>,
  now: Date = new Date(),
) => {
  const symbol = typeof input.symbol === 'string' && input.symbol.trim()
    ? input.symbol.trim().toUpperCase()
    : undefined;
  const holdingId = typeof input.holdingId === 'string' && input.holdingId.trim()
    ? input.holdingId.trim()
    : undefined;
  const positionRequested = Boolean(symbol || holdingId);
  const requestedAccount = input.accountId == null
    ? undefined
    : investmentAccountId(input.accountId);
  const accounts: readonly WealthAccountId[] = requestedAccount && requestedAccount !== 'all'
    ? [requestedAccount]
    : ['bitso', 'ibkr'];
  const candidates = await Promise.all(accounts.map(async (accountId) => ({
    accountId,
    snapshots: await listWealthSnapshotsForAccount(owner, accountId),
  })));
  const matching = positionRequested && (!requestedAccount || requestedAccount === 'all')
    ? candidates.filter(({ snapshots }) => snapshots.some(
      (snapshot) => snapshot.holdings.some((holding) => holdingId
        ? holding.id === holdingId
        : holding.symbol.toUpperCase() === symbol),
    ))
    : candidates;
  if (matching.length === 0) {
    throw new InvalidAgentQueryError(
      `No hay historial de ${holdingId ?? symbol ?? 'esa inversión'}.`,
      'no_data',
    );
  }
  if (matching.length > 1 && positionRequested) {
    throw new InvalidAgentQueryError(
      `${holdingId ? `La posición ${holdingId}` : `El símbolo ${symbol}`} existe en más de una cuenta; indica Bitso o IBKR.`,
      'ambiguous',
      { candidateAccountIds: matching.map(({ accountId }) => accountId) },
    );
  }

  const query: InvestmentHistoryQuery = {
    ...(symbol ? { symbol } : {}),
    ...(holdingId ? { holdingId } : {}),
    ...(typeof input.range === 'string' ? { range: input.range as InvestmentHistoryRange } : {}),
    ...(typeof input.fromDay === 'string' ? { fromDay: input.fromDay } : {}),
    ...(typeof input.toDay === 'string' ? { toDay: input.toDay } : {}),
    ...(typeof input.asOfDay === 'string' ? { asOfDay: input.asOfDay } : {}),
    ...(typeof input.granularity === 'string'
      ? { granularity: input.granularity as InvestmentHistoryGranularity }
      : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
  };
  try {
    if (!positionRequested && (!requestedAccount || requestedAccount === 'all')) {
      if (matching.every(({ snapshots }) => snapshots.length === 0)) {
        throw new InvalidAgentQueryError(
          'No hay historial de Bitso ni IBKR.',
          'no_data',
          { expectedAccountIds: ['bitso', 'ibkr'] },
        );
      }
      const result = investmentHistoryFromSnapshots(
        'all',
        portfolioSnapshotsFromAccounts(matching.flatMap(({ snapshots }) => snapshots)),
        query,
        now,
      );
      return {
        ...result,
        status: result.status,
        expectedAccountIds: ['bitso', 'ibkr'],
        includedAccountIds: matching
          .filter(({ snapshots }) => snapshots.length > 0)
          .map(({ accountId }) => accountId),
        missingAccountIds: matching
          .filter(({ snapshots }) => snapshots.length === 0)
          .map(({ accountId }) => accountId),
        accountCoverage: matching.flatMap(({ accountId, snapshots }) => snapshots.length > 0 ? [{
          accountId,
          availableFromDay: snapshots[0]!.day,
          availableToDay: snapshots[snapshots.length - 1]!.day,
          latestAgeDays: wealthSnapshotAgeDays(snapshots[snapshots.length - 1]!.day, now),
        }] : []),
        coverageStartDay: result.availableFromDay,
        coverageEndDay: result.availableToDay,
        completeCoverageStartDay: (result.completePointCount ?? 0) > 0 ? result.snapshotFromDay : null,
        consolidationMethod: 'latest_known_value_per_account_as_of_each_point',
      };
    }
    return investmentHistoryFromSnapshots(matching[0]!.accountId, matching[0]!.snapshots, query, now);
  } catch (error) {
    if (error instanceof InvalidInvestmentHistoryQueryError) {
      throw new InvalidAgentQueryError(error.message, error.code, error.details);
    }
    throw error;
  }
};

export const proposeRecategorize = async (input: {
  readonly eventId: string;
  readonly categoryId: string;
  readonly merchantRaw?: string;
}): Promise<{
  readonly proposalId: string;
  readonly eventId: string;
  readonly categoryId: string;
  readonly updateRule: true;
  readonly message: string;
}> => {
  if (!input.eventId || !input.categoryId) {
    throw new InvalidAgentQueryError('eventId y categoryId son obligatorios.');
  }
  return {
    proposalId: `recat-${input.eventId}-${input.categoryId}`,
    eventId: input.eventId,
    categoryId: input.categoryId,
    updateRule: true,
    message: `Confirma recategorizar el movimiento ${input.eventId} a ${input.categoryId}`
      + (input.merchantRaw ? ` (y recordar ${input.merchantRaw} para el futuro).` : '.'),
  };
};

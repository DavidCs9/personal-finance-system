import {
  aggregateSpendByCategory,
  aggregateSpendByMerchant,
  computeMonthSummary,
  previousCalendarMonth,
  spendAmountForMonth,
  type CategorizedSpendEvent,
  type MonthSummary,
  type SpendAggregateResult,
  type WealthAccountId,
} from '@finance/domain';
import { getMonthlyPlan } from '../months/service.js';
import { listEventsForMonth } from '../events/queries.js';
import { getWealthOverview, listWealthSnapshotsForAccount } from '../wealth/service.js';
import { listCategories } from '../categories/service.js';
import { isValidMonth } from '../months/monthly-plan.js';
import {
  investmentHistoryFromSnapshots,
  InvalidInvestmentHistoryQueryError,
  type InvestmentHistoryGranularity,
  type InvestmentHistoryQuery,
  type InvestmentHistoryRange,
} from './investment-history.js';

export class InvalidAgentQueryError extends Error {}

const investmentAccountId = (value: unknown): WealthAccountId => {
  if (value === 'bitso' || value === 'ibkr') return value;
  throw new InvalidAgentQueryError('La cuenta debe ser Bitso o IBKR.');
};

const toCategorized = (events: readonly Record<string, unknown>[]): CategorizedSpendEvent[] =>
  events.map((event) => {
    const amount = event.amount as { amountMinor?: number } | undefined;
    return {
      id: String(event.id),
      amountMinor: Number(amount?.amountMinor ?? 0),
      status: String(event.status ?? 'accepted'),
      occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : undefined,
      receivedAt: String(event.receivedAt ?? new Date(0).toISOString()),
      merchantRaw: String(event.merchantRaw ?? ''),
      categoryId: (event.categoryId as string | null | undefined) ?? null,
      msi: event.msi as CategorizedSpendEvent['msi'],
    };
  });

const categoryNameMap = async (): Promise<Map<string, string>> => {
  const categories = await listCategories();
  return new Map(categories.map((category) => [category.id, category.name]));
};

const loadMonthEvents = async (month: string): Promise<CategorizedSpendEvent[]> => {
  if (!isValidMonth(month)) throw new InvalidAgentQueryError('Mes inválido (YYYY-MM).');
  const feed = await listEventsForMonth(month);
  const events = [
    ...((feed.events as readonly Record<string, unknown>[]) ?? []),
    ...((feed.msiRelated as readonly Record<string, unknown>[]) ?? []),
  ];
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (typeof event.id === 'string') byId.set(event.id, event);
  }
  return toCategorized([...byId.values()]);
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
  month: string,
  options?: { readonly categoryId?: string; readonly limit?: number },
): Promise<{
  readonly month: string;
  readonly movements: readonly {
    readonly id: string;
    readonly merchantRaw: string;
    readonly categoryId: string | null;
    readonly amountMinor: number;
    readonly status: string;
  }[];
  readonly truncated: boolean;
}> => {
  const events = await loadMonthEvents(month);
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
  const categoryFilter = options?.categoryId;
  const movements = events
    .map((event) => ({
      id: event.id,
      merchantRaw: event.merchantRaw,
      categoryId: event.categoryId ?? null,
      amountMinor: spendAmountForMonth(event, month),
      status: event.status,
    }))
    .filter((row) => {
      if (row.amountMinor <= 0) return false;
      if (!categoryFilter) return true;
      if (categoryFilter === '_uncategorized') return row.categoryId === null;
      return row.categoryId === categoryFilter;
    })
    .sort((left, right) => right.amountMinor - left.amountMinor);
  return {
    month,
    movements: movements.slice(0, limit),
    truncated: movements.length > limit,
  };
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
  const requestedAccount = input.accountId === undefined
    ? undefined
    : investmentAccountId(input.accountId);
  if (!requestedAccount && !symbol) {
    throw new InvalidAgentQueryError('Indica accountId o un símbolo que permita inferir la cuenta.');
  }

  const accounts: readonly WealthAccountId[] = requestedAccount ? [requestedAccount] : ['bitso', 'ibkr'];
  const candidates = await Promise.all(accounts.map(async (accountId) => ({
    accountId,
    snapshots: await listWealthSnapshotsForAccount(owner, accountId),
  })));
  const matching = requestedAccount || !symbol
    ? candidates
    : candidates.filter(({ snapshots }) => snapshots.some(
      (snapshot) => snapshot.holdings.some((holding) => holding.symbol.toUpperCase() === symbol),
    ));
  if (matching.length === 0) {
    throw new InvalidAgentQueryError(`No hay historial de ${symbol ?? 'esa inversión'}.`);
  }
  if (matching.length > 1) {
    throw new InvalidAgentQueryError(`El símbolo ${symbol} existe en más de una cuenta; indica Bitso o IBKR.`);
  }

  const query: InvestmentHistoryQuery = {
    ...(symbol ? { symbol } : {}),
    ...(typeof input.range === 'string' ? { range: input.range as InvestmentHistoryRange } : {}),
    ...(typeof input.fromDay === 'string' ? { fromDay: input.fromDay } : {}),
    ...(typeof input.toDay === 'string' ? { toDay: input.toDay } : {}),
    ...(typeof input.granularity === 'string'
      ? { granularity: input.granularity as InvestmentHistoryGranularity }
      : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
  };
  try {
    return investmentHistoryFromSnapshots(matching[0]!.accountId, matching[0]!.snapshots, query, now);
  } catch (error) {
    if (error instanceof InvalidInvestmentHistoryQueryError) {
      throw new InvalidAgentQueryError(error.message);
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

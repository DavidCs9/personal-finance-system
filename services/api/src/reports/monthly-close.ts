import {
  aggregateSpendByCategory,
  aggregateSpendByMerchant,
  aggregateSpendByTag,
  daysInCalendarMonth,
  formatMxnWhole,
  previousCalendarMonth,
  WEALTH_TOTAL_HISTORY_START_MONTH,
  type CategorizedSpendEvent,
  type SpendBucket,
} from '@finance/domain';
import { listCategories } from '../categories/service.js';
import { loadCategorizedMonthsEvents } from '../analytics/events.js';
import {
  getWealthOverviewAsOf,
  type WealthBalanceOverview,
} from '../wealth/service.js';

export const MONTHLY_CLOSE_FACTS_VERSION = 'monthly-close-facts-v1';

export interface MonthlyCloseCategoryFact {
  readonly key: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly eventCount: number;
  readonly shareBasisPoints: number;
  readonly againstAmountMinor: number;
  readonly deltaMinor: number;
  readonly priorThreeMonthAverageMinor: number;
  readonly versusAverageMinor: number;
  readonly uncertainMinor: number;
  readonly topMerchants: readonly {
    readonly label: string;
    readonly amountMinor: number;
    readonly eventCount: number;
  }[];
}

export interface MonthlyCloseTagFact {
  readonly key: string;
  readonly amountMinor: number;
  readonly eventCount: number;
  readonly againstAmountMinor: number;
  readonly deltaMinor: number;
}

export interface MonthlyCloseAccountFact {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly shareBasisPoints: number;
  readonly priorAmountMinor: number | null;
  readonly deltaMinor: number | null;
  readonly snapshotDay: string | null;
  readonly ageDays: number | null;
  readonly stale: boolean;
  readonly role: string;
}

export interface MonthlyCloseLiabilityFact {
  readonly cardId: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly priorAmountMinor: number | null;
  readonly deltaMinor: number | null;
  readonly snapshotDay: string | null;
  readonly ageDays: number | null;
  readonly stale: boolean;
}

export type MonthlyCloseSignalKind =
  | 'category_increase'
  | 'tag_context'
  | 'uncategorized'
  | 'uncertain'
  | 'wealth_concentration'
  | 'wealth_decline'
  | 'liability_increase'
  | 'stale_balance';

export interface MonthlyCloseSignal {
  readonly id: string;
  readonly kind: MonthlyCloseSignalKind;
  readonly priority: number;
  readonly message: string;
  readonly action: string;
}

export interface MonthlyCloseFacts {
  readonly version: typeof MONTHLY_CLOSE_FACTS_VERSION;
  readonly month: string;
  readonly closeDay: string;
  readonly againstMonth: string;
  readonly generatedAt: string;
  readonly spending: {
    readonly totalSpentMinor: number;
    readonly againstSpentMinor: number;
    readonly deltaMinor: number;
    readonly uncertainMinor: number;
    readonly uncategorizedMinor: number;
    readonly uncategorizedEventCount: number;
    readonly categories: readonly MonthlyCloseCategoryFact[];
    readonly tags: readonly MonthlyCloseTagFact[];
    readonly merchants: readonly {
      readonly label: string;
      readonly amountMinor: number;
      readonly eventCount: number;
    }[];
  };
  readonly wealth: {
    readonly comparable: boolean;
    readonly netMxnMinor: number;
    readonly assetsMxnMinor: number;
    readonly liabilitiesMxnMinor: number;
    readonly priorNetMxnMinor: number | null;
    readonly netDeltaMinor: number | null;
    readonly accounts: readonly MonthlyCloseAccountFact[];
    readonly liabilities: readonly MonthlyCloseLiabilityFact[];
  };
  readonly signals: readonly MonthlyCloseSignal[];
}

export interface MonthlyCloseFactDependencies {
  readonly loadEvents: (months: readonly string[]) => Promise<readonly CategorizedSpendEvent[]>;
  readonly loadCategories: typeof listCategories;
  readonly loadWealthAsOf: (owner: string, day: string) => Promise<WealthBalanceOverview>;
}

const defaultDependencies: MonthlyCloseFactDependencies = {
  loadEvents: loadCategorizedMonthsEvents,
  loadCategories: listCategories,
  loadWealthAsOf: getWealthOverviewAsOf,
};

const requiredPreviousMonth = (month: string): string => {
  const previous = previousCalendarMonth(month);
  if (!previous) throw new Error(`Invalid report month ${month}.`);
  return previous;
};

export const monthCloseDay = (month: string): string =>
  `${month}-${String(daysInCalendarMonth(month)).padStart(2, '0')}`;

const monthsBefore = (month: string, count: number): readonly string[] => {
  const months: string[] = [];
  let cursor = month;
  for (let index = 0; index < count; index += 1) {
    cursor = requiredPreviousMonth(cursor);
    months.push(cursor);
  }
  return months;
};

const basisPoints = (amountMinor: number, totalMinor: number): number =>
  totalMinor > 0 ? Math.round((amountMinor / totalMinor) * 10_000) : 0;

const wholePercent = (basisPointValue: number): string => `${Math.round(basisPointValue / 100)}%`;

const bucketMap = (buckets: readonly SpendBucket[]): ReadonlyMap<string, SpendBucket> =>
  new Map(buckets.map((bucket) => [bucket.key, bucket]));

const dayAge = (snapshotDay: string | null, closeDay: string): number | null => {
  if (!snapshotDay) return null;
  const start = Date.parse(`${snapshotDay}T12:00:00.000Z`);
  const end = Date.parse(`${closeDay}T12:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
};

const accountFacts = (
  current: WealthBalanceOverview,
  previous: WealthBalanceOverview | undefined,
): readonly MonthlyCloseAccountFact[] => {
  const priorById = new Map(previous?.accounts.map((account) => [account.id, account]) ?? []);
  return current.accounts.map((account) => {
    const amountMinor = account.latestSnapshot?.totalMxnMinor ?? 0;
    const prior = priorById.get(account.id)?.latestSnapshot?.totalMxnMinor;
    const ageDays = dayAge(account.latestSnapshot?.day ?? null, current.asOfDay);
    return {
      id: account.id,
      name: account.name,
      role: account.role,
      amountMinor,
      shareBasisPoints: basisPoints(amountMinor, current.assetsMxnMinor),
      priorAmountMinor: prior ?? null,
      deltaMinor: prior === undefined ? null : amountMinor - prior,
      snapshotDay: account.latestSnapshot?.day ?? null,
      ageDays,
      stale: ageDays === null || ageDays >= 7,
    };
  });
};

const liabilityFacts = (
  current: WealthBalanceOverview,
  previous: WealthBalanceOverview | undefined,
): readonly MonthlyCloseLiabilityFact[] => {
  const priorById = new Map(previous?.liabilities.map((liability) => [liability.cardId, liability]) ?? []);
  return current.liabilities.map((liability) => {
    const amountMinor = liability.latestSnapshot?.totalMxnMinor ?? 0;
    const prior = priorById.get(liability.cardId)?.latestSnapshot?.totalMxnMinor;
    const ageDays = dayAge(liability.latestSnapshot?.day ?? null, current.asOfDay);
    return {
      cardId: liability.cardId,
      name: liability.name,
      amountMinor,
      priorAmountMinor: prior ?? null,
      deltaMinor: prior === undefined ? null : amountMinor - prior,
      snapshotDay: liability.latestSnapshot?.day ?? null,
      ageDays,
      stale: ageDays === null || ageDays >= 7,
    };
  });
};

const signalFacts = (input: {
  readonly spendingTotalMinor: number;
  readonly categories: readonly MonthlyCloseCategoryFact[];
  readonly tags: readonly MonthlyCloseTagFact[];
  readonly uncategorizedMinor: number;
  readonly uncategorizedEventCount: number;
  readonly uncertainMinor: number;
  readonly wealthComparable: boolean;
  readonly wealthDeltaMinor: number | null;
  readonly accounts: readonly MonthlyCloseAccountFact[];
  readonly liabilities: readonly MonthlyCloseLiabilityFact[];
}): readonly MonthlyCloseSignal[] => {
  const signals: MonthlyCloseSignal[] = [];
  const categoryIncrease = input.categories
    .filter((category) => category.deltaMinor > 0 && category.shareBasisPoints >= 1_000)
    .sort((left, right) => right.deltaMinor - left.deltaMinor)[0];
  if (categoryIncrease) {
    const merchants = categoryIncrease.topMerchants.slice(0, 2).map((merchant) => merchant.label).join(' y ');
    signals.push({
      id: `category:${categoryIncrease.key}`,
      kind: 'category_increase',
      priority: 80,
      message: `${categoryIncrease.label} subió ${formatMxnWhole(categoryIncrease.deltaMinor)} frente al mes anterior${merchants ? `; ${merchants} concentraron la mayor parte` : ''}.`,
      action: `Revisa los movimientos principales de ${categoryIncrease.label} antes del siguiente corte.`,
    });
  }
  const topTag = input.tags[0];
  if (topTag && basisPoints(topTag.amountMinor, input.spendingTotalMinor) >= 2_500) {
    signals.push({
      id: `tag:${topTag.key}`,
      kind: 'tag_context',
      priority: 45,
      message: `El contexto ${topTag.key} agrupó ${formatMxnWhole(topTag.amountMinor)} en ${topTag.eventCount} movimientos; puede cruzar varias categorías.`,
      action: `Abre los movimientos con el tag ${topTag.key} para entender ese contexto completo.`,
    });
  }
  if (input.uncategorizedMinor > 0) {
    signals.push({
      id: 'spending:uncategorized',
      kind: 'uncategorized',
      priority: 90,
      message: `Hay ${formatMxnWhole(input.uncategorizedMinor)} sin categoría en ${input.uncategorizedEventCount} movimientos.`,
      action: `Clasifica los ${input.uncategorizedEventCount} movimientos pendientes para completar la lectura del mes.`,
    });
  }
  if (input.uncertainMinor > 0) {
    signals.push({
      id: 'spending:uncertain',
      kind: 'uncertain',
      priority: 95,
      message: `El cierre incluye ${formatMxnWhole(input.uncertainMinor)} por confirmar.`,
      action: 'Revisa los movimientos por confirmar antes de tomar este cierre como definitivo.',
    });
  }
  const concentrated = [...input.accounts].sort((left, right) => right.shareBasisPoints - left.shareBasisPoints)[0];
  if (concentrated && concentrated.shareBasisPoints >= 5_000) {
    signals.push({
      id: `wealth:concentration:${concentrated.id}`,
      kind: 'wealth_concentration',
      priority: 55,
      message: `${concentrated.name} concentra ${wholePercent(concentrated.shareBasisPoints)} de tus activos.`,
      action: `Observa si la concentración en ${concentrated.name} sigue creciendo el próximo mes.`,
    });
  }
  if (input.wealthComparable && input.wealthDeltaMinor !== null && input.wealthDeltaMinor < 0) {
    signals.push({
      id: 'wealth:decline',
      kind: 'wealth_decline',
      priority: 85,
      message: `Tu patrimonio neto bajó ${formatMxnWhole(Math.abs(input.wealthDeltaMinor))} desde el cierre anterior.`,
      action: 'Revisa qué cuentas y deudas explicaron la disminución patrimonial.',
    });
  }
  const liabilityIncrease = input.liabilities.reduce(
    (sum, liability) => sum + Math.max(liability.deltaMinor ?? 0, 0),
    0,
  );
  if (input.wealthComparable && liabilityIncrease > 0) {
    signals.push({
      id: 'wealth:liability-increase',
      kind: 'liability_increase',
      priority: 75,
      message: `Los saldos de tarjeta aumentaron ${formatMxnWhole(liabilityIncrease)} frente al cierre anterior.`,
      action: 'Revisa el aumento de tarjetas antes de sus próximas fechas de pago.',
    });
  }
  for (const stale of [
    ...input.accounts.filter((account) => account.stale).map((account) => ({ id: account.id, name: account.name, ageDays: account.ageDays })),
    ...input.liabilities.filter((liability) => liability.stale).map((liability) => ({ id: liability.cardId, name: liability.name, ageDays: liability.ageDays })),
  ]) {
    signals.push({
      id: `stale:${stale.id}`,
      kind: 'stale_balance',
      priority: 100,
      message: stale.ageDays === null
        ? `${stale.name} no tiene una captura disponible.`
        : `${stale.name} no se actualiza desde hace ${stale.ageDays} días.`,
      action: `Actualiza ${stale.name} para confirmar el cierre patrimonial.`,
    });
  }
  return signals.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
};

export const buildMonthlyCloseFacts = async (
  owner: string,
  month: string,
  now: Date = new Date(),
  dependencies: MonthlyCloseFactDependencies = defaultDependencies,
): Promise<MonthlyCloseFacts> => {
  const priorMonths = monthsBefore(month, 3);
  const againstMonth = priorMonths[0]!;
  const closeDay = monthCloseDay(month);
  const comparableWealth = month > WEALTH_TOTAL_HISTORY_START_MONTH;
  const previousWealthDay = monthCloseDay(againstMonth);
  const [events, categories, currentWealth, previousWealth] = await Promise.all([
    dependencies.loadEvents([month, ...priorMonths]),
    dependencies.loadCategories(),
    dependencies.loadWealthAsOf(owner, closeDay),
    comparableWealth ? dependencies.loadWealthAsOf(owner, previousWealthDay) : Promise.resolve(undefined),
  ]);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const currentCategories = aggregateSpendByCategory(events, month, categoryNames);
  const priorCategoryAggregates = priorMonths.map((priorMonth) =>
    aggregateSpendByCategory(events, priorMonth, categoryNames),
  );
  const againstCategories = bucketMap(priorCategoryAggregates[0]!.buckets);
  const priorCategoryMaps = priorCategoryAggregates.map((aggregate) => bucketMap(aggregate.buckets));
  const categoriesFacts: readonly MonthlyCloseCategoryFact[] = currentCategories.buckets.map((bucket) => {
    const againstAmountMinor = againstCategories.get(bucket.key)?.amountMinor ?? 0;
    const priorThreeMonthAverageMinor = Math.round(
      priorCategoryMaps.reduce((sum, map) => sum + (map.get(bucket.key)?.amountMinor ?? 0), 0) / priorCategoryMaps.length,
    );
    const merchants = aggregateSpendByMerchant(events, month, { categoryId: bucket.key, limit: 3 });
    return {
      key: bucket.key,
      label: bucket.label,
      amountMinor: bucket.amountMinor,
      eventCount: bucket.eventCount,
      shareBasisPoints: basisPoints(bucket.amountMinor, currentCategories.totalSpentMinor),
      againstAmountMinor,
      deltaMinor: bucket.amountMinor - againstAmountMinor,
      priorThreeMonthAverageMinor,
      versusAverageMinor: bucket.amountMinor - priorThreeMonthAverageMinor,
      uncertainMinor: bucket.uncertainMinor,
      topMerchants: merchants.buckets.map((merchant) => ({
        label: merchant.label,
        amountMinor: merchant.amountMinor,
        eventCount: merchant.eventCount,
      })),
    };
  });
  const currentTags = aggregateSpendByTag(events, month);
  const againstTags = bucketMap(aggregateSpendByTag(events, againstMonth).buckets);
  const tags: readonly MonthlyCloseTagFact[] = currentTags.buckets.slice(0, 20).map((tag) => {
    const againstAmountMinor = againstTags.get(tag.key)?.amountMinor ?? 0;
    return {
      key: tag.key,
      amountMinor: tag.amountMinor,
      eventCount: tag.eventCount,
      againstAmountMinor,
      deltaMinor: tag.amountMinor - againstAmountMinor,
    };
  });
  const merchants = aggregateSpendByMerchant(events, month, { limit: 10 }).buckets.map((merchant) => ({
    label: merchant.label,
    amountMinor: merchant.amountMinor,
    eventCount: merchant.eventCount,
  }));
  const accounts = accountFacts(currentWealth, previousWealth);
  const liabilities = liabilityFacts(currentWealth, previousWealth);
  const hasComparableWealth = comparableWealth && Boolean(previousWealth)
    && (previousWealth!.assetsMxnMinor > 0 || previousWealth!.liabilitiesMxnMinor > 0);
  const netDeltaMinor = hasComparableWealth ? currentWealth.netMxnMinor - previousWealth!.netMxnMinor : null;
  const signals = signalFacts({
    spendingTotalMinor: currentCategories.totalSpentMinor,
    categories: categoriesFacts,
    tags,
    uncategorizedMinor: currentCategories.uncategorizedMinor,
    uncategorizedEventCount: currentCategories.uncategorizedEventCount,
    uncertainMinor: currentCategories.uncertainMinor,
    wealthComparable: hasComparableWealth,
    wealthDeltaMinor: netDeltaMinor,
    accounts,
    liabilities,
  });
  return {
    version: MONTHLY_CLOSE_FACTS_VERSION,
    month,
    closeDay,
    againstMonth,
    generatedAt: now.toISOString(),
    spending: {
      totalSpentMinor: currentCategories.totalSpentMinor,
      againstSpentMinor: priorCategoryAggregates[0]!.totalSpentMinor,
      deltaMinor: currentCategories.totalSpentMinor - priorCategoryAggregates[0]!.totalSpentMinor,
      uncertainMinor: currentCategories.uncertainMinor,
      uncategorizedMinor: currentCategories.uncategorizedMinor,
      uncategorizedEventCount: currentCategories.uncategorizedEventCount,
      categories: categoriesFacts,
      tags,
      merchants,
    },
    wealth: {
      comparable: hasComparableWealth,
      netMxnMinor: currentWealth.netMxnMinor,
      assetsMxnMinor: currentWealth.assetsMxnMinor,
      liabilitiesMxnMinor: currentWealth.liabilitiesMxnMinor,
      priorNetMxnMinor: hasComparableWealth ? previousWealth!.netMxnMinor : null,
      netDeltaMinor,
      accounts,
      liabilities,
    },
    signals,
  };
};

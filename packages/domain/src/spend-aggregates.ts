import {
  countsTowardMonthSpend,
  dayKeyInZone,
  eventMonthKey,
  personalSpendAmountMinor,
  type MonthSpendEvent,
} from "./month-summary.js";

export interface CategorizedSpendEvent extends MonthSpendEvent {
  readonly id: string;
  readonly merchantRaw: string;
  readonly categoryId?: string | null;
  readonly tags?: readonly string[];
}

export interface SpendBucket {
  readonly key: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly eventCount: number;
  readonly uncertainMinor: number;
  readonly eventIds: readonly string[];
}

export interface SpendAggregateResult {
  readonly month: string;
  readonly totalSpentMinor: number;
  readonly uncategorizedMinor: number;
  readonly uncategorizedEventCount: number;
  readonly uncertainMinor: number;
  readonly buckets: readonly SpendBucket[];
}

export interface SpendComparisonBucket extends SpendBucket {
  readonly againstAmountMinor: number;
  readonly againstEventIds: readonly string[];
  readonly deltaMinor: number;
}

export interface SpendingAnalytics {
  readonly month: string;
  readonly comparison: {
    readonly againstMonth: string;
    readonly throughDay?: number;
    readonly amountMinor: number;
    readonly againstAmountMinor: number;
    readonly deltaMinor: number;
    readonly excludedMonthOnlyMinor: number;
  };
  readonly categories: readonly SpendComparisonBucket[];
  readonly tags: readonly SpendBucket[];
  readonly merchants: readonly SpendBucket[];
  readonly confidence: {
    readonly uncategorizedMinor: number;
    readonly uncategorizedEventCount: number;
    readonly uncertainMinor: number;
    readonly uncertainEventIds: readonly string[];
  };
}

export interface SpendAggregateOptions {
  /** Include only known spend evidence through this calendar day. Month-only legacy MSI remains included. */
  readonly throughDay?: number;
}

const calendarDayFor = (value: string | undefined, month: string): number | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value.startsWith(`${month}-`) ? Number(value.slice(8, 10)) : undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = dayKeyInZone(date);
  return day.startsWith(`${month}-`) ? Number(day.slice(8, 10)) : undefined;
};

export const monthOnlySpendAmountForMonth = (event: MonthSpendEvent, month: string): number => {
  if (!countsTowardMonthSpend(event.status) || !event.msi) return 0;
  return event.msi.installments
    .filter((installment) => installment.month === month && installment.status === "spent")
    .filter((installment) => (
      calendarDayFor(installment.occurredOn, month)
      ?? calendarDayFor(installment.confirmedAt, month)
    ) === undefined)
    .reduce((sum, installment) => sum + installment.amountMinor, 0);
};

/** Amount that counts as "Has gastado" for this event in `month` (MSI = cuota spent). */
export const spendAmountForMonth = (
  event: MonthSpendEvent,
  month: string,
  options?: SpendAggregateOptions,
): number => {
  if (!countsTowardMonthSpend(event.status)) return 0;
  if (event.msi) {
    return event.msi.installments
      .filter((installment) => {
        if (installment.month !== month || installment.status !== "spent") return false;
        if (options?.throughDay === undefined) return true;
        const knownDay = calendarDayFor(installment.occurredOn, month)
          ?? calendarDayFor(installment.confirmedAt, month);
        // A partial-period comparison cannot place legacy month-only MSI on an invented day.
        return knownDay !== undefined && knownDay <= options.throughDay;
      })
      .reduce((sum, installment) => sum + installment.amountMinor, 0);
  }
  if (eventMonthKey(event) !== month) return 0;
  if (options?.throughDay !== undefined) {
    const day = Number(dayKeyInZone(new Date(event.occurredAt ?? event.receivedAt)).slice(8, 10));
    if (day > options.throughDay) return 0;
  }
  return personalSpendAmountMinor(event);
};

export const uncertainAmountForMonth = (
  event: MonthSpendEvent,
  month: string,
  options?: SpendAggregateOptions,
): number => {
  if (event.status !== "needs_review") return 0;
  return spendAmountForMonth(event, month, options);
};

const pushBucket = (
  map: Map<string, { label: string; amountMinor: number; eventCount: number; uncertainMinor: number; eventIds: string[] }>,
  key: string,
  label: string,
  amountMinor: number,
  uncertainMinor: number,
  eventId: string,
): void => {
  const existing = map.get(key);
  if (existing) {
    existing.amountMinor += amountMinor;
    existing.eventCount += 1;
    existing.uncertainMinor += uncertainMinor;
    existing.eventIds.push(eventId);
    return;
  }
  map.set(key, {
    label,
    amountMinor,
    eventCount: 1,
    uncertainMinor,
    eventIds: [eventId],
  });
};

export const aggregateSpendByCategory = (
  events: readonly CategorizedSpendEvent[],
  month: string,
  categoryNames: ReadonlyMap<string, string>,
  options?: SpendAggregateOptions,
): SpendAggregateResult => {
  const buckets = new Map<
    string,
    { label: string; amountMinor: number; eventCount: number; uncertainMinor: number; eventIds: string[] }
  >();
  let totalSpentMinor = 0;
  let uncategorizedMinor = 0;
  let uncategorizedEventCount = 0;
  let uncertainMinor = 0;

  for (const event of events) {
    const amountMinor = spendAmountForMonth(event, month, options);
    if (amountMinor <= 0) continue;
    totalSpentMinor += amountMinor;
    const uncertain = uncertainAmountForMonth(event, month, options);
    uncertainMinor += uncertain;
    const categoryId = event.categoryId ?? null;
    if (!categoryId) {
      uncategorizedMinor += amountMinor;
      uncategorizedEventCount += 1;
      pushBucket(buckets, "_uncategorized", "Sin categoría", amountMinor, uncertain, event.id);
      continue;
    }
    pushBucket(
      buckets,
      categoryId,
      categoryNames.get(categoryId) ?? categoryId,
      amountMinor,
      uncertain,
      event.id,
    );
  }

  return {
    month,
    totalSpentMinor,
    uncategorizedMinor,
    uncategorizedEventCount,
    uncertainMinor,
    buckets: [...buckets.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((left, right) => right.amountMinor - left.amountMinor),
  };
};

export const aggregateSpendByMerchant = (
  events: readonly CategorizedSpendEvent[],
  month: string,
  options?: SpendAggregateOptions & { readonly categoryId?: string; readonly limit?: number },
): SpendAggregateResult => {
  const buckets = new Map<
    string,
    { label: string; amountMinor: number; eventCount: number; uncertainMinor: number; eventIds: string[] }
  >();
  let totalSpentMinor = 0;
  let uncategorizedMinor = 0;
  let uncategorizedEventCount = 0;
  let uncertainMinor = 0;
  const categoryFilter = options?.categoryId;

  for (const event of events) {
    if (categoryFilter) {
      if (categoryFilter === "_uncategorized") {
        if (event.categoryId) continue;
      } else if (event.categoryId !== categoryFilter) {
        continue;
      }
    }
    const amountMinor = spendAmountForMonth(event, month, options);
    if (amountMinor <= 0) continue;
    totalSpentMinor += amountMinor;
    const uncertain = uncertainAmountForMonth(event, month, options);
    uncertainMinor += uncertain;
    if (!event.categoryId) {
      uncategorizedMinor += amountMinor;
      uncategorizedEventCount += 1;
    }
    const label = event.merchantRaw || "Sin comercio";
    pushBucket(buckets, label.toLowerCase(), label, amountMinor, uncertain, event.id);
  }

  const sorted = [...buckets.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.amountMinor - left.amountMinor);
  const limit = options?.limit ?? 25;

  return {
    month,
    totalSpentMinor,
    uncategorizedMinor,
    uncategorizedEventCount,
    uncertainMinor,
    buckets: sorted.slice(0, limit),
  };
};

/** Tags are overlapping context lenses; their bucket totals are intentionally not additive. */
export const aggregateSpendByTag = (
  events: readonly CategorizedSpendEvent[],
  month: string,
  options?: SpendAggregateOptions,
): SpendAggregateResult => {
  const buckets = new Map<
    string,
    { label: string; amountMinor: number; eventCount: number; uncertainMinor: number; eventIds: string[] }
  >();
  let totalSpentMinor = 0;
  let uncategorizedMinor = 0;
  let uncategorizedEventCount = 0;
  let uncertainMinor = 0;

  for (const event of events) {
    const amountMinor = spendAmountForMonth(event, month, options);
    if (amountMinor <= 0) continue;
    totalSpentMinor += amountMinor;
    const uncertain = uncertainAmountForMonth(event, month, options);
    uncertainMinor += uncertain;
    if (!event.categoryId) {
      uncategorizedMinor += amountMinor;
      uncategorizedEventCount += 1;
    }
    for (const tag of new Set(event.tags ?? [])) {
      pushBucket(buckets, tag, tag, amountMinor, uncertain, event.id);
    }
  }

  return {
    month,
    totalSpentMinor,
    uncategorizedMinor,
    uncategorizedEventCount,
    uncertainMinor,
    buckets: [...buckets.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((left, right) => right.amountMinor - left.amountMinor),
  };
};

export const compareSpendBuckets = (
  current: readonly SpendBucket[],
  against: readonly SpendBucket[],
): readonly SpendComparisonBucket[] => {
  const currentByKey = new Map(current.map((bucket) => [bucket.key, bucket]));
  const againstByKey = new Map(against.map((bucket) => [bucket.key, bucket]));
  const keys = new Set([...currentByKey.keys(), ...againstByKey.keys()]);
  return [...keys].map((key) => {
    const bucket = currentByKey.get(key);
    const prior = againstByKey.get(key);
    const amountMinor = bucket?.amountMinor ?? 0;
    const againstAmountMinor = prior?.amountMinor ?? 0;
    return {
      key,
      label: bucket?.label ?? prior?.label ?? key,
      amountMinor,
      againstAmountMinor,
      againstEventIds: prior?.eventIds ?? [],
      deltaMinor: amountMinor - againstAmountMinor,
      eventCount: bucket?.eventCount ?? 0,
      uncertainMinor: bucket?.uncertainMinor ?? 0,
      eventIds: bucket?.eventIds ?? [],
    };
  }).sort((left, right) => right.amountMinor - left.amountMinor || Math.abs(right.deltaMinor) - Math.abs(left.deltaMinor));
};

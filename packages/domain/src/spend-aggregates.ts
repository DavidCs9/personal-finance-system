import {
  countsTowardMonthSpend,
  eventMonthKey,
  type MonthSpendEvent,
} from "./month-summary.js";

export interface CategorizedSpendEvent extends MonthSpendEvent {
  readonly id: string;
  readonly merchantRaw: string;
  readonly categoryId?: string | null;
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

/** Amount that counts as "Has gastado" for this event in `month` (MSI = cuota spent). */
export const spendAmountForMonth = (event: MonthSpendEvent, month: string): number => {
  if (!countsTowardMonthSpend(event.status)) return 0;
  if (event.msi) {
    return event.msi.installments
      .filter((installment) => installment.month === month && installment.status === "spent")
      .reduce((sum, installment) => sum + installment.amountMinor, 0);
  }
  return eventMonthKey(event) === month ? event.amountMinor : 0;
};

export const uncertainAmountForMonth = (event: MonthSpendEvent, month: string): number => {
  if (event.status !== "needs_review") return 0;
  return spendAmountForMonth(event, month);
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
    const amountMinor = spendAmountForMonth(event, month);
    if (amountMinor <= 0) continue;
    totalSpentMinor += amountMinor;
    const uncertain = uncertainAmountForMonth(event, month);
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
  options?: { readonly categoryId?: string; readonly limit?: number },
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
    const amountMinor = spendAmountForMonth(event, month);
    if (amountMinor <= 0) continue;
    totalSpentMinor += amountMinor;
    const uncertain = uncertainAmountForMonth(event, month);
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

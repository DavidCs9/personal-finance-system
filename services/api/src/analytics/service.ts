import {
  aggregateSpendByCategory,
  aggregateSpendByMerchant,
  aggregateSpendByTag,
  compareSpendBuckets,
  dayInZone,
  daysInCalendarMonth,
  monthKeyInZone,
  monthOnlySpendAmountForMonth,
  previousCalendarMonth,
  uncertainAmountForMonth,
  type SpendingAnalytics,
} from '@finance/domain';
import { listCategories } from '../categories/service.js';
import { loadCategorizedMonthsEvents } from './events.js';

export const getSpendingAnalytics = async (
  month: string,
  now: Date = new Date(),
): Promise<SpendingAnalytics> => {
  const againstMonth = previousCalendarMonth(month);
  if (!againstMonth) throw new Error(`Cannot compare invalid month ${month}.`);

  const [events, categories] = await Promise.all([
    loadCategorizedMonthsEvents([month, againstMonth]),
    listCategories(),
  ]);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const current = aggregateSpendByCategory(events, month, categoryNames);
  const isCurrentMonth = month === monthKeyInZone(now);
  const throughDay = isCurrentMonth
    ? Math.min(dayInZone(now), daysInCalendarMonth(againstMonth))
    : undefined;
  const against = aggregateSpendByCategory(
    events,
    againstMonth,
    categoryNames,
    throughDay === undefined ? undefined : { throughDay },
  );
  const tags = aggregateSpendByTag(events, month);
  const merchants = aggregateSpendByMerchant(events, month, { limit: 10 });
  const excludedMonthOnlyMinor = throughDay === undefined
    ? 0
    : events.reduce((sum, event) => sum + monthOnlySpendAmountForMonth(event, againstMonth), 0);

  return {
    month,
    comparison: {
      againstMonth,
      ...(throughDay === undefined ? {} : { throughDay }),
      amountMinor: current.totalSpentMinor,
      againstAmountMinor: against.totalSpentMinor,
      deltaMinor: current.totalSpentMinor - against.totalSpentMinor,
      excludedMonthOnlyMinor,
    },
    categories: compareSpendBuckets(current.buckets, against.buckets),
    tags: tags.buckets,
    merchants: merchants.buckets,
    confidence: {
      uncategorizedMinor: current.uncategorizedMinor,
      uncategorizedEventCount: current.uncategorizedEventCount,
      uncertainMinor: current.uncertainMinor,
      uncertainEventIds: events
        .filter((event) => uncertainAmountForMonth(event, month) > 0)
        .map((event) => event.id),
    },
  };
};

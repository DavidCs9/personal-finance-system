import type { CategorizedSpendEvent } from '@finance/domain';
import { listEventsForMonth, listEventsForMonths } from '../events/queries.js';

const toCategorized = (events: readonly Record<string, unknown>[]): CategorizedSpendEvent[] =>
  events.map((event) => {
    const amount = event.amount as { amountMinor?: number } | undefined;
    return {
      id: String(event.id),
      amountMinor: Number(amount?.amountMinor ?? 0),
      personalAmountMinor: typeof event.personalAmountMinor === 'number' ? event.personalAmountMinor : undefined,
      status: String(event.status ?? 'accepted'),
      occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : undefined,
      receivedAt: String(event.receivedAt ?? new Date(0).toISOString()),
      merchantRaw: String(event.merchantRaw ?? ''),
      categoryId: (event.categoryId as string | null | undefined) ?? null,
      tags: Array.isArray(event.tags) ? event.tags.map(String) : [],
      msi: event.msi as CategorizedSpendEvent['msi'],
    };
  });

const deduplicateFeed = (feed: {
  readonly events: readonly Record<string, unknown>[];
  readonly msiRelated: readonly Record<string, unknown>[];
}): CategorizedSpendEvent[] => {
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of [...feed.events, ...feed.msiRelated]) {
    if (typeof event.id === 'string') byId.set(event.id, event);
  }
  return toCategorized([...byId.values()]);
};

export const loadCategorizedMonthEvents = async (month: string): Promise<CategorizedSpendEvent[]> =>
  deduplicateFeed(await listEventsForMonth(month));

export const loadCategorizedMonthsEvents = async (
  months: readonly string[],
): Promise<CategorizedSpendEvent[]> => deduplicateFeed(await listEventsForMonths(months));

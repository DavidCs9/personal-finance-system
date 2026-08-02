/** Pure month-feed selection used by GET /events?month= (GSI3 query results in, feed out). */

export type MonthFeedEvent = {
  readonly id: string;
  readonly msi?: {
    readonly installments?: readonly { readonly month?: string }[];
  };
};

export const eventHasInstallmentInMonth = (event: MonthFeedEvent, month: string): boolean =>
  Boolean(event.msi?.installments?.some((installment) => installment.month === month));

/**
 * `events` = purchases whose spend month is `month`.
 * `msiRelated` = earlier purchases with an installment in `month`, excluding ids already in `events`.
 */
export const buildMonthEventFeed = <T extends MonthFeedEvent>(
  month: string,
  events: readonly T[],
  lookbackCandidates: readonly T[],
): { readonly events: readonly T[]; readonly msiRelated: readonly T[] } => {
  const eventIds = new Set(events.map((event) => event.id));
  const msiRelated: T[] = [];
  const seen = new Set<string>();
  for (const candidate of lookbackCandidates) {
    if (eventIds.has(candidate.id) || seen.has(candidate.id)) continue;
    if (!eventHasInstallmentInMonth(candidate, month)) continue;
    seen.add(candidate.id);
    msiRelated.push(candidate);
  }
  return { events, msiRelated };
};

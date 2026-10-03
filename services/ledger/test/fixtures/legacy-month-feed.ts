import { eventHasInstallmentInMonth, type MonthFeedEvent } from '../../src/event-month-feed.js';

/** Independent historical feed oracle for regression verification. */
/**
 * `events` = purchases whose spend month is `month`.
 * `msiRelated` = other purchases with an installment in `month` (earlier or later index month),
 * excluding ids already in `events`. Later index months cover plans opened from mid-plan evidence
 * before they were re-anchored to cuota 1.
 */
export const buildMonthEventFeed = <T extends MonthFeedEvent>(
  month: string,
  events: readonly T[],
  nearbyCandidates: readonly T[],
): { readonly events: readonly T[]; readonly msiRelated: readonly T[] } => {
  const eventIds = new Set(events.map((event) => event.id));
  const msiRelated: T[] = [];
  const seen = new Set<string>();
  for (const candidate of nearbyCandidates) {
    if (eventIds.has(candidate.id) || seen.has(candidate.id)) continue;
    if (!eventHasInstallmentInMonth(candidate, month)) continue;
    seen.add(candidate.id);
    msiRelated.push(candidate);
  }
  return { events, msiRelated };
};

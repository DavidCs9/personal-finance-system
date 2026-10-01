import { eventHasInstallmentInMonth, eventMonthIndexKeys, nextCalendarMonths, priorCalendarMonths, type MonthFeedEvent } from '@finance/ledger';
import type { JsonObject } from '../http/response.js';
import { toPublicEvent } from './public-event.js';

export type EventFeed = { readonly events: readonly JsonObject[]; readonly msiRelated: readonly JsonObject[] };
export const candidateMonthsFor = (months: readonly string[]): string[] => [...new Set(months.flatMap(month =>
  [month, ...priorCalendarMonths(month, 24), ...nextCalendarMonths(month, 24)]))];
export const spendMonthOf = (payload: JsonObject): string => eventMonthIndexKeys({
  eventId: String(payload.id), occurredAt: payload.occurredAt as string | undefined, receivedAt: String(payload.receivedAt),
}).spendMonth;

/** Preserve the original GSI feed contract, including lexical timestamp/id ordering and +/-24 month MSI scope. */
export const feedFromPayloads = (months: readonly string[], payloads: readonly JsonObject[]): EventFeed => {
  const requested = [...new Set(months)];
  const candidates = candidateMonthsFor(requested);
  const buckets = new Map<string, JsonObject[]>();
  for (const payload of payloads) {
    const month = spendMonthOf(payload);
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month)!.push(payload);
  }
  const key = (event: JsonObject) => `${event.occurredAt ?? event.receivedAt}#${event.id}`;
  for (const bucket of buckets.values()) bucket.sort((a, b) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0);
  const events = requested.flatMap(month => (buckets.get(month) ?? []).map(payload => toPublicEvent(payload)));
  const seen = new Set(events.map(event => String(event.id)));
  const msiRelated: JsonObject[] = [];
  // The legacy adapter inserts ALL requested months before surrounding months.
  const orderedCandidates = [...new Set([...requested, ...candidates])];
  for (const month of orderedCandidates) {
    if (requested.includes(month)) continue;
    for (const payload of buckets.get(month) ?? []) {
      const id = String(payload.id);
      if (seen.has(id) || !requested.some(target => eventHasInstallmentInMonth(payload as unknown as MonthFeedEvent, target))) continue;
      seen.add(id);
      msiRelated.push(toPublicEvent(payload));
    }
  }
  return { events, msiRelated };
};

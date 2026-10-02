import { monthKeyInZone } from '@finance/domain';
import { eventHasInstallmentInMonth, type MonthFeedEvent } from '@finance/ledger';
import type { JsonObject } from '../http/response.js';
import { toPublicEvent } from './public-event.js';

export type EventFeed = { readonly events: readonly JsonObject[]; readonly msiRelated: readonly JsonObject[] };
export const spendMonthOf = (movement: JsonObject): string =>
  monthKeyInZone(new Date(String(movement.occurredAt ?? movement.receivedAt)));

/** Group canonical purchases and actual cuota relationships without a purchase-age cutoff. */
export const feedFromMovements = (months: readonly string[], movements: readonly JsonObject[]): EventFeed => {
  const requested = [...new Set(months)];
  if (!requested.length) return { events: [], msiRelated: [] };
  const buckets = new Map<string, JsonObject[]>();
  for (const movement of movements) {
    const month = spendMonthOf(movement);
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month)!.push(movement);
  }
  const key = (event: JsonObject) => `${event.occurredAt ?? event.receivedAt}#${event.id}`;
  for (const bucket of buckets.values()) bucket.sort((a, b) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0);
  const events = requested.flatMap(month => (buckets.get(month) ?? []).map(movement => toPublicEvent(movement)));
  const seen = new Set(events.map(event => String(event.id)));
  const msiRelated: JsonObject[] = [];
  const availableMonths = [...buckets.keys()].filter(month => !requested.includes(month));
  const orderedMonths = [...new Set(requested.flatMap(month => [
    ...availableMonths.filter(candidate => candidate < month).sort().reverse(),
    ...availableMonths.filter(candidate => candidate > month).sort(),
  ]))];
  for (const month of orderedMonths) for (const movement of buckets.get(month) ?? []) {
    const id = String(movement.id);
    if (seen.has(id) || !requested.some(target => eventHasInstallmentInMonth(movement as unknown as MonthFeedEvent, target))) continue;
    seen.add(id); msiRelated.push(toPublicEvent(movement));
  }
  return { events, msiRelated };
};

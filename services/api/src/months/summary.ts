import { computeMonthSummary, type MonthSpendEvent, type MonthSummary } from '@finance/domain';
import { listEventsForMonth } from '../events/queries.js';
import { getMonthlyPlan } from './service.js';
import type { JsonObject } from '../http/response.js';

type MonthEventFeed = {
  readonly events: readonly JsonObject[];
  readonly msiRelated: readonly JsonObject[];
};

const toMonthSpendEvent = (event: JsonObject): MonthSpendEvent => {
  const amount = event.amount as { readonly amountMinor?: unknown } | undefined;
  return {
    id: typeof event.id === 'string' ? event.id : undefined,
    amountMinor: typeof amount?.amountMinor === 'number' ? amount.amountMinor : 0,
    personalAmountMinor: typeof event.personalAmountMinor === 'number' ? event.personalAmountMinor : undefined,
    status: typeof event.status === 'string' ? event.status : 'accepted',
    occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : undefined,
    receivedAt: typeof event.receivedAt === 'string' ? event.receivedAt : new Date(0).toISOString(),
    merchantRaw: typeof event.merchantRaw === 'string' ? event.merchantRaw : undefined,
    msi: event.msi as MonthSpendEvent['msi'],
  };
};

/** Deduplicates the event feed while retaining prior purchases with a cuota in this month. */
export const monthSpendEventsFromFeed = (feed: MonthEventFeed): readonly MonthSpendEvent[] => {
  const byId = new Map<string, MonthSpendEvent>();
  for (const event of [...feed.events, ...feed.msiRelated]) {
    const monthEvent = toMonthSpendEvent(event);
    if (monthEvent.id) byId.set(monthEvent.id, monthEvent);
  }
  return [...byId.values()];
};

export const summarizeMonthFeed = (
  month: string,
  plan: JsonObject,
  feed: MonthEventFeed,
  now: Date = new Date(),
): MonthSummary => {
  const upcomingPayments = Array.isArray(plan.upcomingPayments) ? plan.upcomingPayments : [];
  const upcomingPaymentsMinor = upcomingPayments.reduce((sum, payment) => {
    const amountMinor = payment && typeof payment === 'object'
      ? (payment as { readonly amountMinor?: unknown }).amountMinor
      : undefined;
    return typeof amountMinor === 'number' ? sum + amountMinor : sum;
  }, 0);
  return computeMonthSummary({
    events: monthSpendEventsFromFeed(feed),
    month,
    incomeMinor: typeof plan.incomeMinor === 'number' ? plan.incomeMinor : 0,
    incomeConfigured: plan.configured === true,
    upcomingPaymentsMinor,
    now,
  });
};

/** Canonical monthly spend summary for the dashboard, assistant, and daily push. */
export const getMonthSummary = async (
  owner: string,
  month: string,
  now: Date = new Date(),
): Promise<MonthSummary> => {
  const [plan, feed] = await Promise.all([getMonthlyPlan(owner, month), listEventsForMonth(month)]);
  return summarizeMonthFeed(month, plan, feed, now);
};

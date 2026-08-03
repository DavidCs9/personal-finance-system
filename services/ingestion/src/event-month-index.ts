import { addCalendarMonths, monthKeyInZone } from "@finance/domain";

/** GSI3 partition for calendar-month event listing (America/Chihuahua spend month). */
export const eventMonthPartition = (month: string): string => `MONTH#${month}`;

export const eventMonthIndexKeys = (input: {
  readonly eventId: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
}): { readonly spendMonth: string; readonly GSI3PK: string; readonly GSI3SK: string } => {
  const at = input.occurredAt ?? input.receivedAt;
  const spendMonth = monthKeyInZone(new Date(at));
  return {
    spendMonth,
    GSI3PK: eventMonthPartition(spendMonth),
    GSI3SK: `${at}#${input.eventId}`,
  };
};

/** Inclusive lookback of prior calendar months (does not include `month` itself). */
export const priorCalendarMonths = (month: string, count: number): readonly string[] => {
  if (!/^\d{4}-\d{2}$/.test(month) || count < 1) return [];
  const months: string[] = [];
  for (let offset = 1; offset <= count; offset += 1) {
    months.push(addCalendarMonths(month, -offset));
  }
  return months;
};

/** Inclusive lookahead of later calendar months (does not include `month` itself). */
export const nextCalendarMonths = (month: string, count: number): readonly string[] => {
  if (!/^\d{4}-\d{2}$/.test(month) || count < 1) return [];
  const months: string[] = [];
  for (let offset = 1; offset <= count; offset += 1) {
    months.push(addCalendarMonths(month, offset));
  }
  return months;
};

/**
 * Purchase `occurredAt` for an event opened from MSI evidence.
 * Always anchors on cuota 1's month so GSI3 / month feeds expose the plan from 1/n,
 * even when the statement row is 2/n or later. Keeps the evidence day-of-month.
 */
export const msiPlanPurchaseOccurredAt = (
  evidenceOccurredOn: string,
  startMonth: string | undefined,
): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidenceOccurredOn)) {
    return `${evidenceOccurredOn}T12:00:00.000Z`;
  }
  if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) {
    return `${evidenceOccurredOn}T12:00:00.000Z`;
  }
  return `${startMonth}-${evidenceOccurredOn.slice(8, 10)}T12:00:00.000Z`;
};

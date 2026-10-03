/**
 * Purchase `occurredAt` for an event opened from MSI evidence.
 * Anchors on cuota 1's month so financial month feeds expose the plan from 1/n,
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

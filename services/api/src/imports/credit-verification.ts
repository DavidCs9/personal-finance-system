import type { JsonObject } from '../http/response.js';

export const isBankCredit = (row: { amountMinor: number; credit?: boolean }): boolean =>
  row.credit === true || row.amountMinor < 0;

export const hasManualMovementEvidence = (event: JsonObject): boolean =>
  event.captureSource === 'manual' || (event.captureSources as string[] | undefined)?.includes('manual') === true;

export const movementAmountMatches = (event: JsonObject, row: { amountMinor: number }): boolean =>
  (event.amount as JsonObject | undefined)?.amountMinor === Math.abs(row.amountMinor);

/** Only verify a classified credit. The direction of a bank line does not identify its accounting type. */
export const bankCreditCandidates = (input: {
  readonly row: { amountMinor: number; occurredOn: string; purchaseOn?: string; merchantRaw: string };
  readonly events: readonly JsonObject[];
  readonly institution: string;
  readonly accountLastFour: string;
  readonly localDate: (value: unknown) => string | undefined;
  readonly merchantsMatch: (left: string, right: string) => boolean;
}) => input.events.filter(event => {
  if (event.eventType !== "bank_credit" || event.institution !== input.institution || event.accountKind !== "credit_card" || event.status === 'rejected') return false;
  const account = event.account as JsonObject | undefined;
  const amount = event.amount as JsonObject | undefined;
  const day = event.postedOn;
  return (!account?.lastFour || account.lastFour === input.accountLastFour) && amount?.currency === 'MXN'
    && (hasManualMovementEvidence(event) || movementAmountMatches(event, input.row))
    && (day === input.row.occurredOn || (input.row.purchaseOn !== undefined && day === input.row.purchaseOn))
    && input.merchantsMatch(String(event.merchantRaw), input.row.merchantRaw);
});

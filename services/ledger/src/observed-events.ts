export { normaliseMerchant, foreignMerchantsMatch } from './reconciliation-matching.js';

export type CaptureSource =
  | 'email'
  | 'apple_pay_shortcut'
  | 'santander_csv'
  | 'manual'
  | 'amex_statement'
  | 'santander_statement';

export interface ObservedEventInput {
  readonly id: string;
  readonly institution: string;
  readonly eventType: string;
  readonly status: string;
  readonly account?: Readonly<Record<string, unknown>>;
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly merchantRaw: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly ingestedAt: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly parserVersion: string;
  readonly parseWarnings: readonly string[];
  readonly [key: string]: unknown;
}

export interface SaveObservedEventResult {
  readonly eventId: string;
  readonly observationId: string;
  readonly duplicate: boolean;
  readonly reconciled: boolean;
  readonly created: boolean;
}

/** Retained only until statement/CSV financial writers move to native SQL. */
export const reconciliationPartition = (event: Pick<ObservedEventInput, 'institution' | 'eventType' | 'amount'>): string =>
  `RECON#${event.institution}#${event.eventType}#${event.amount.currency}#${event.amount.amountMinor}`;

import type { EventRevision, Institution, Money, RawSourcePointer } from "@finance/domain";

export type ReviewStatus = "accepted" | "needs_review" | "rejected";

export interface PurchaseEvent {
  readonly id: string;
  readonly institution: Institution;
  readonly eventType?: "card_purchase" | "outgoing_transfer" | "card_charge";
  readonly billingPeriod?: string;
  readonly paymentMethodLastFour?: string;
  readonly status: ReviewStatus;
  readonly accountName: string;
  readonly amount: Money;
  readonly merchantRaw: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly ingestedAt: string;
  readonly parserVersion: string;
  readonly source: RawSourcePointer;
  readonly parseWarnings: readonly string[];
  readonly rawEmail?: string;
  readonly revisions: readonly EventRevision[];
}

export interface EventFeed {
  readonly events: readonly PurchaseEvent[];
}

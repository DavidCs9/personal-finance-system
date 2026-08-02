import type { EventRevision, Institution, Money, ObservedSourcePointer } from "@finance/domain";

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
  readonly source: ObservedSourcePointer;
  readonly hasRawEmail?: boolean;
  readonly parseWarnings: readonly string[];
  readonly rawEmail?: string;
  readonly revisions: readonly EventRevision[];
}

export interface EventFeed {
  readonly events: readonly PurchaseEvent[];
}

export interface IngestionException {
  readonly id: string;
  readonly receivedAt: string;
  readonly institution?: Institution;
  readonly reason: string;
  readonly details: string;
  readonly retry?: { readonly status: "queued" | "completed"; readonly eventId?: string };
}

export type SantanderImportRowStatus = "new" | "matched" | "ambiguous" | "duplicate" | "excluded";

export interface SantanderImportCandidate {
  readonly id: string;
  readonly merchantRaw: string;
  readonly occurredAt?: string;
}

export interface SantanderImportRow {
  readonly rowNumber: number;
  readonly occurredOn: string;
  readonly transactionId?: string;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly identity: string;
  readonly status: SantanderImportRowStatus;
  readonly candidates: readonly SantanderImportCandidate[];
}

export interface SantanderImportPreview {
  readonly importId: string;
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly summary: {
    readonly total: number;
    readonly new: number;
    readonly matched: number;
    readonly ambiguous: number;
    readonly duplicate: number;
    readonly excluded: number;
  };
  readonly rows: readonly SantanderImportRow[];
}

export interface SantanderImportDecision {
  readonly action: "create" | "link";
  readonly eventId?: string;
}

export interface SantanderImportResult {
  readonly importId: string;
  readonly created: readonly PurchaseEvent[];
  readonly summary: { readonly created: number; readonly linked: number; readonly skipped: number };
}

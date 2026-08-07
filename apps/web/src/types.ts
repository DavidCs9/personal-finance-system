import type {
  CaptureSource,
  EventRevision,
  Institution,
  Money,
  MsiPlan,
  ObservedSourcePointer,
} from "@finance/domain";

export type ReviewStatus = "accepted" | "needs_review" | "rejected" | "deferred_msi";

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
  readonly categoryId?: string | null;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly ingestedAt: string;
  readonly parserVersion: string;
  readonly source: ObservedSourcePointer;
  readonly captureSource?: CaptureSource;
  readonly captureSources?: readonly CaptureSource[];
  readonly hasRawEmail?: boolean;
  readonly parseWarnings: readonly string[];
  readonly rawEmail?: string;
  readonly revisions: readonly EventRevision[];
  readonly msi?: MsiPlan;
}

export interface ManualEventInput {
  readonly institution: Institution;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly accountLastFour?: string;
  readonly note?: string;
}

export interface EventFeed {
  readonly events: readonly PurchaseEvent[];
  readonly msiRelated: readonly PurchaseEvent[];
}

export interface IngestionException {
  readonly id: string;
  readonly receivedAt: string;
  readonly institution?: Institution;
  readonly reason: string;
  readonly details: string;
  readonly retry?: { readonly status: "queued" | "completed"; readonly eventId?: string };
}

export type SantanderImportRowStatus =
  | "new"
  | "matched"
  | "ambiguous"
  | "duplicate"
  | "excluded"
  | "needs_decision";

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
  readonly candidateEventIds?: readonly string[];
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
    readonly needsDecision?: number;
  };
  readonly rows: readonly SantanderImportRow[];
}

export interface SantanderImportDecision {
  readonly action: "create" | "link" | "confirm_msi" | "create_plan" | "skip";
  readonly eventId?: string;
  readonly months?: number;
  readonly cuotaMinor?: number;
  readonly startMonth?: string;
}

export interface SantanderImportResult {
  readonly importId: string;
  readonly created: readonly PurchaseEvent[];
  readonly summary: {
    readonly created: number;
    readonly linked: number;
    readonly skipped: number;
    readonly msiConfirmed?: number;
  };
}

export type StatementImportStatus = "processing" | "ready";

export type StatementRowKind = "purchase" | "msi";

export type StatementRowStatus =
  | "new"
  | "matched"
  | "ambiguous"
  | "duplicate"
  | "excluded"
  | "needs_decision"
  | "unplanned"
  | "skipped";

export interface StatementImportCandidate {
  readonly id: string;
  readonly merchantRaw: string;
  readonly occurredAt?: string;
}

export interface StatementImportRow {
  readonly identity: string;
  readonly kind: StatementRowKind;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
  readonly originalAmountMinor?: number;
  readonly status: StatementRowStatus;
  readonly eventId?: string;
  readonly candidateEventIds?: readonly string[];
  readonly candidates?: readonly StatementImportCandidate[];
  readonly msi?: boolean;
}

export interface StatementImportSummary {
  readonly total: number;
  readonly new: number;
  readonly matched: number;
  readonly ambiguous: number;
  readonly duplicate: number;
  readonly excluded: number;
  readonly needsDecision?: number;
  readonly unplanned?: number;
  readonly skipped: number;
  readonly purchases: number;
  readonly msi: number;
}

export interface AmexImportPreview {
  readonly importId: string;
  readonly status: StatementImportStatus;
  readonly message?: string;
  readonly accountLastFour?: string;
  readonly product?: string;
  readonly period?: { readonly from: string; readonly to: string };
  readonly summary?: StatementImportSummary;
  readonly rows?: readonly StatementImportRow[];
}

export interface AmexImportResult {
  readonly importId: string;
  readonly created: readonly PurchaseEvent[];
  readonly summary: {
    readonly created: number;
    readonly linked: number;
    readonly skipped: number;
    readonly msiConfirmed: number;
    readonly createdUnplanned: number;
  };
}

export type SantanderStatementImportPreview = AmexImportPreview;
export type SantanderStatementImportResult = AmexImportResult;
export type StatementImportDecision = SantanderImportDecision;

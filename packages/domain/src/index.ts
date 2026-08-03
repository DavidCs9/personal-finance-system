import type { MsiPlan } from "./msi.js";

export const INSTITUTIONS = ["american_express_mx", "santander_mx", "nu_mx", "amazon_web_services"] as const;

export type Institution = (typeof INSTITUTIONS)[number];

export type EventStatus = "accepted" | "needs_review" | "rejected";

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface AccountReference {
  readonly institution: Institution;
  readonly accountId: string;
  readonly displayName: string;
  readonly lastFour?: string;
}

export interface RawSourcePointer {
  readonly kind?: "email";
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly contentType: "message/rfc822" | "text/csv" | "application/json" | "text/plain";
}

export interface ApplePayShortcutSourcePointer {
  readonly kind: "apple_pay_shortcut";
  readonly requestId: string;
  readonly cardRaw: string;
  readonly nameRaw?: string;
}

export interface ManualEntrySourcePointer {
  readonly kind: "manual_entry";
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly contentType: "application/json";
}

export type ObservedSourcePointer = RawSourcePointer | ApplePayShortcutSourcePointer | ManualEntrySourcePointer;
export type CaptureSource =
  | "email"
  | "apple_pay_shortcut"
  | "santander_csv"
  | "manual"
  | "amex_statement"
  | "santander_statement";

export interface ObservedPurchase {
  readonly id: string;
  readonly institution: Institution;
  readonly eventType: "card_purchase" | "outgoing_transfer" | "card_charge";
  readonly status: EventStatus;
  readonly account?: AccountReference;
  readonly amount: Money;
  readonly merchantRaw: string;
  readonly msi?: MsiPlan;
  /** For transfers, the recipient shown in the bank confirmation. */
  readonly counterparty?: string;
  readonly transferType?: "spei";
  readonly reference?: string;
  readonly folio?: string;
  readonly trackingKey?: string;
  readonly counterpartyInstitution?: string;
  readonly counterpartyAccountLastFour?: string;
  readonly billingPeriod?: string;
  readonly paymentMethodLastFour?: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly ingestedAt: string;
  readonly sourceMessageId?: string;
  readonly source: ObservedSourcePointer;
  readonly captureSource?: CaptureSource;
  readonly captureSources?: readonly CaptureSource[];
  readonly observationCount?: number;
  readonly primaryObservationId?: string;
  readonly reconciledAt?: string;
  readonly hasRawEmail?: boolean;
  readonly bankTransactionId?: string;
  readonly parserVersion: string;
  readonly parseWarnings: readonly string[];
}

export interface EventRevision {
  readonly id: string;
  readonly observedPurchaseId: string;
  readonly createdAt: string;
  readonly changedBy: string;
  readonly reason?: string;
  readonly changes: Readonly<Record<string, { readonly previous: unknown; readonly next: unknown }>>;
}

export interface IngestionException {
  readonly id: string;
  readonly receivedAt: string;
  readonly institution?: Institution;
  readonly reason: "unsupported_source" | "parser_failed" | "missing_required_data" | "ambiguous_duplicate";
  readonly source: RawSourcePointer;
  readonly details: string;
}

export const isInstitution = (value: string): value is Institution =>
  (INSTITUTIONS as readonly string[]).includes(value);

export {
  FINANCE_TIME_ZONE,
  computeMonthSummary,
  dailyBalancePushMessage,
  dayInZone,
  dayKeyInZone,
  daysInCalendarMonth,
  eventMonthKey,
  formatMxnWhole,
  listCommittedMsiRows,
  listMonthMsiRows,
  monthKeyInZone,
  type CommittedMsiRow,
  type DailyBalancePushMessage,
  type MonthMsiRow,
  type MonthSpendEvent,
  type MonthSummary,
  type MonthSummaryInput,
  type PushContentMode,
} from "./month-summary.js";

export {
  cardCyclePushMessage,
  cardRemindersForDay,
  clampDayInMonth,
  type CardCycleKind,
  type CardCycleProfile,
  type CardCyclePushMessage,
  type CardCycleReminder,
} from "./card-cycle.js";

export {
  AMEX_AUTO_MSI_MONTHS,
  AMEX_AUTO_MSI_THRESHOLD_MINOR,
  MSI_AMOUNT_TOLERANCE_MINOR,
  addCalendarMonths,
  amountsWithinTolerance,
  buildMsiSchedule,
  cancelRemainingInstallments,
  completeUnplannedSchedule,
  defaultCuotaMinor,
  findMsiEvidenceMatch,
  isMsiLikeMerchant,
  markInstallmentSpent,
  maybeAutoAmexMsi,
  msiLabel,
  replaceMsiSchedule,
  type InstallmentStatus,
  type MsiEvidenceCandidate,
  type MsiInstallment,
  type MsiOrigin,
  type MsiPlan,
  type MsiPlanStatus,
  type MsiScheduleInput,
} from "./msi.js";

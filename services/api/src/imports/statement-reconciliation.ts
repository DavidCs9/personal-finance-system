import { createHash } from "node:crypto";
import { merchantsMatch as santanderMerchantsMatch } from "./santander-csv.js";
import { amexMerchantsMatch, canCreateMsiPlanFromEvidence } from "./msi-reconciliation.js";
import type { StatementProvider } from "./textract-document.js";

export type { StatementProvider };

export type StatementRowKind = "purchase" | "msi";

/** Full-statement preview statuses: purchase reconcile + MSI evidence. */
export type StatementRowStatus =
  | "new"
  | "matched"
  | "ambiguous"
  | "duplicate"
  | "excluded"
  | "needs_decision"
  | "skipped";

export interface StatementCandidate {
  readonly id: string;
  readonly merchantRaw: string;
  readonly occurredAt?: string;
}

export interface StatementPreviewRow {
  readonly identity: string;
  readonly kind: StatementRowKind;
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly credit?: boolean;
  readonly msi?: boolean;
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
  readonly originalAmountMinor?: number;
  readonly status: StatementRowStatus;
  readonly eventId?: string;
  readonly candidateEventIds: readonly string[];
  readonly candidates: readonly StatementCandidate[];
}

export type StatementDecision =
  | { readonly action: "create" }
  | { readonly action: "link"; readonly eventId: string }
  | { readonly action: "confirm_msi"; readonly eventId: string }
  | {
      readonly action: "create_plan";
      readonly months: number;
      readonly cuotaMinor: number;
      readonly startMonth?: string;
    }
  | { readonly action: "skip" };

export type StatementApplyAction =
  | { readonly kind: "create" }
  | { readonly kind: "link"; readonly eventId: string }
  | { readonly kind: "confirm_msi"; readonly eventId: string }
  | {
      readonly kind: "create_plan";
      readonly months: number;
      readonly cuotaMinor: number;
      readonly startMonth?: string;
    }
  | { readonly kind: "skip" };

export const statementClaimKey = (
  provider: StatementProvider,
  identity: string,
): { readonly PK: string; readonly SK: string } => ({
  PK: `DEDUPE#${provider === "amex" ? "AMEX_STATEMENT" : "SANTANDER_STATEMENT"}#${createHash("sha256").update(identity).digest("hex")}`,
  SK: "CLAIM",
});

export const statementMerchantsMatch = (
  provider: StatementProvider,
  left: string,
  right: string,
): boolean => (provider === "amex" ? amexMerchantsMatch(left, right) : santanderMerchantsMatch(left, right));

export const classifyPurchaseCharge = (input: {
  readonly provider: StatementProvider;
  readonly accountLastFour: string;
  readonly institution: "american_express_mx" | "santander_mx";
  readonly charge: {
    readonly identity: string;
    readonly merchantRaw: string;
    readonly amountMinor: number;
    readonly occurredOn: string;
    readonly credit?: boolean;
  };
  readonly events: readonly Record<string, unknown>[];
  readonly claimed: ReadonlySet<string>;
  readonly localDate: (value: unknown) => string | undefined;
}): StatementPreviewRow => {
  const base = {
    identity: input.charge.identity,
    kind: "purchase" as const,
    merchantRaw: input.charge.merchantRaw,
    amountMinor: input.charge.amountMinor,
    occurredOn: input.charge.occurredOn,
    credit: input.charge.credit,
    msi: false,
    candidateEventIds: [] as string[],
    candidates: [] as StatementCandidate[],
  };
  if (input.claimed.has(statementClaimKey(input.provider, input.charge.identity).PK)) {
    return { ...base, status: "duplicate" };
  }
  if (input.charge.credit || input.charge.amountMinor <= 0) {
    return { ...base, status: "excluded" };
  }

  const candidates = input.events.filter((event) => {
    if (event.institution !== input.institution) return false;
    if (event.status === "rejected") return false;
    const account = event.account as Record<string, unknown> | undefined;
    const amount = event.amount as Record<string, unknown> | undefined;
    return account?.lastFour === input.accountLastFour
      && amount?.currency === "MXN"
      && amount.amountMinor === input.charge.amountMinor
      && input.localDate(event.occurredAt ?? event.receivedAt) === input.charge.occurredOn
      && typeof event.merchantRaw === "string"
      && statementMerchantsMatch(input.provider, event.merchantRaw, input.charge.merchantRaw);
  });
  const summaries = candidates.map((candidate) => ({
    id: String(candidate.id),
    merchantRaw: String(candidate.merchantRaw),
    ...(typeof candidate.occurredAt === "string" ? { occurredAt: candidate.occurredAt } : {}),
  }));
  if (candidates.length === 1) {
    return {
      ...base,
      status: "matched",
      eventId: String(candidates[0].id),
      candidateEventIds: [String(candidates[0].id)],
      candidates: summaries,
    };
  }
  if (candidates.length > 1) {
    return {
      ...base,
      status: "ambiguous",
      candidateEventIds: candidates.map((candidate) => String(candidate.id)),
      candidates: summaries,
    };
  }
  return { ...base, status: "new" };
};

export const statementPurchaseApplyAction = (
  current: StatementPreviewRow,
  preview: StatementPreviewRow | undefined,
  decision?: StatementDecision,
): StatementApplyAction => {
  if (current.kind !== "purchase") return { kind: "skip" };
  if (current.status === "new" && preview?.status === "new") return { kind: "create" };
  if (
    current.status === "matched"
    && preview?.status === "matched"
    && current.candidateEventIds[0]
    && current.candidateEventIds[0] === preview.candidateEventIds[0]
  ) {
    return { kind: "link", eventId: current.candidateEventIds[0] };
  }
  if (current.status === "ambiguous" && preview?.status === "ambiguous") {
    if (decision?.action === "create") return { kind: "create" };
    if (decision?.action === "link" && current.candidateEventIds.includes(decision.eventId)) {
      return { kind: "link", eventId: decision.eventId };
    }
  }
  return { kind: "skip" };
};

export const statementMsiApplyAction = (
  current: StatementPreviewRow,
  preview: StatementPreviewRow | undefined,
  decision?: StatementDecision,
): StatementApplyAction => {
  if (current.kind !== "msi") return { kind: "skip" };
  if (current.status === "skipped" || preview?.status === "skipped") return { kind: "skip" };
  if (
    current.status === "matched"
    && preview?.status === "matched"
    && current.eventId
    && current.eventId === preview.eventId
  ) {
    return { kind: "confirm_msi", eventId: current.eventId };
  }
  if (current.status === "needs_decision" && preview?.status === "needs_decision") {
    if (decision?.action === "skip") {
      // With n/N + cuota on the statement, omit means "accept the plan as printed".
      if (
        canCreateMsiPlanFromEvidence({
          amountMinor: current.amountMinor,
          installmentIndex: current.installmentIndex,
          installmentMonths: current.installmentMonths,
          originalAmountMinor: current.originalAmountMinor,
        })
      ) {
        return {
          kind: "create_plan",
          months: current.installmentMonths!,
          cuotaMinor: current.amountMinor,
        };
      }
      return { kind: "skip" };
    }
    if (decision?.action === "confirm_msi") {
      const allowed = current.candidateEventIds.length === 0
        || current.candidateEventIds.includes(decision.eventId);
      if (allowed) return { kind: "confirm_msi", eventId: decision.eventId };
    }
    if (decision?.action === "create_plan") {
      return {
        kind: "create_plan",
        months: decision.months,
        cuotaMinor: decision.cuotaMinor,
        ...(decision.startMonth ? { startMonth: decision.startMonth } : {}),
      };
    }
    // Allow link as synonym for confirm when candidates exist (web reuse).
    if (decision?.action === "link" && current.candidateEventIds.includes(decision.eventId)) {
      return { kind: "confirm_msi", eventId: decision.eventId };
    }
  }
  return { kind: "skip" };
};

export const statementPreviewSummary = (rows: readonly StatementPreviewRow[]) => {
  const count = (status: StatementRowStatus) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    new: count("new"),
    matched: count("matched"),
    ambiguous: count("ambiguous"),
    duplicate: count("duplicate"),
    excluded: count("excluded"),
    needsDecision: count("needs_decision"),
    /** @deprecated alias for needsDecision — kept for older UI snapshots */
    unplanned: count("needs_decision"),
    skipped: count("skipped"),
    purchases: rows.filter((row) => row.kind === "purchase").length,
    msi: rows.filter((row) => row.kind === "msi").length,
  };
};

export const statementImportCompletionUpdate = (
  appliedAt: string,
  result: {
    readonly created: number;
    readonly linked: number;
    readonly skipped: number;
    readonly msiConfirmed: number;
    readonly createdUnplanned: number;
  },
) => ({
  UpdateExpression: "SET #status = :status, #appliedAt = :appliedAt, #result = :result",
  ExpressionAttributeNames: { "#status": "status", "#appliedAt": "appliedAt", "#result": "result" },
  ExpressionAttributeValues: { ":status": "applied", ":appliedAt": appliedAt, ":result": result },
});

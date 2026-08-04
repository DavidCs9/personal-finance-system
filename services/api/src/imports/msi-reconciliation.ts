import {
  amountsWithinTolerance,
  buildMsiSchedule,
  isMsiLikeMerchant,
  markInstallmentSpent,
  monthKeyInZone,
  type MsiEvidenceCandidate,
  type MsiInstallment,
  type MsiPlan,
} from "@finance/domain";
import { merchantsMatch as santanderMerchantsMatch } from "./santander-csv.js";

export type JsonObject = Record<string, unknown>;

export interface EvidenceLine {
  readonly merchantRaw: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
  readonly originalAmountMinor?: number;
  readonly identity: string;
}

export type EvidenceMatchResult =
  | {
      readonly kind: "confirm";
      readonly eventId: string;
      readonly previous: MsiPlan;
      readonly next: MsiPlan;
      readonly installmentIndex: number;
    }
  | {
      readonly kind: "needs_decision";
      readonly reason: string;
      readonly candidates: readonly MsiEvidenceCandidate[];
    }
  | { readonly kind: "skip"; readonly reason: string };

const asMsiPlan = (value: unknown): MsiPlan | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const plan = value as MsiPlan;
  if (!Array.isArray(plan.installments) || !Number.isInteger(plan.months)) return undefined;
  return plan;
};

/** True for Amex statement labels that omit the real merchant. */
export const isAutomaticAmexLabel = (merchantRaw: string): boolean =>
  /MESES EN AUTOM[AÁ]TICO/i.test(merchantRaw);

export const evidenceCandidatesFromEvents = (
  events: readonly JsonObject[],
): readonly MsiEvidenceCandidate[] => {
  const candidates: MsiEvidenceCandidate[] = [];
  for (const event of events) {
    const plan = asMsiPlan(event.msi);
    if (!plan || event.status === "rejected") continue;
    // Incomplete stubs must not receive automatic confirms.
    if (plan.needsScheduleCompletion) continue;
    for (const installment of plan.installments) {
      if (installment.status !== "committed") continue;
      candidates.push({
        eventId: String(event.id),
        merchantRaw: String(event.merchantRaw ?? ""),
        plan,
        installment,
      });
    }
  }
  return candidates;
};

type PlanCandidate = {
  readonly eventId: string;
  readonly merchantRaw: string;
  readonly plan: MsiPlan;
};

/** Plans that could own this evidence (merchant + principal/cuota), ignoring calendar drift. */
export const matchingPlansForEvidence = (
  line: EvidenceLine,
  events: readonly JsonObject[],
): readonly PlanCandidate[] => {
  const matches: PlanCandidate[] = [];
  for (const event of events) {
    const plan = asMsiPlan(event.msi);
    if (!plan || event.status === "rejected") continue;
    if (plan.needsScheduleCompletion) continue;
    if (
      line.installmentMonths !== undefined
      && plan.months !== line.installmentMonths
    ) {
      continue;
    }
    if (!amountsWithinTolerance(plan.cuotaMinor, line.amountMinor)) continue;

    if (isAutomaticAmexLabel(line.merchantRaw)) {
      if (line.originalAmountMinor === undefined) continue;
      if (!amountsWithinTolerance(plan.principalMinor, line.originalAmountMinor)) continue;
      // Automatic labels collapse many merchants — principal is the identity.
      matches.push({
        eventId: String(event.id),
        merchantRaw: String(event.merchantRaw ?? ""),
        plan,
      });
      continue;
    }

    if (!amexMerchantsMatch(String(event.merchantRaw ?? ""), line.merchantRaw)) continue;

    if (
      line.originalAmountMinor !== undefined
      && !amountsWithinTolerance(plan.principalMinor, line.originalAmountMinor)
    ) {
      continue;
    }

    matches.push({
      eventId: String(event.id),
      merchantRaw: String(event.merchantRaw ?? ""),
      plan,
    });
  }
  return matches;
};

/** Merchant equality for statement matching. Automatic Amex labels never match arbitrary merchants. */
export const amexMerchantsMatch = (left: string, right: string): boolean => {
  if (isAutomaticAmexLabel(left) || isAutomaticAmexLabel(right)) {
    return isAutomaticAmexLabel(left) && isAutomaticAmexLabel(right);
  }
  return santanderMerchantsMatch(left, right);
};

const confirmMatch = (
  match: MsiEvidenceCandidate,
  line: EvidenceLine,
): EvidenceMatchResult => ({
  kind: "confirm",
  eventId: match.eventId,
  previous: match.plan,
  next: markInstallmentSpent(match.plan, match.installment.index, {
    amountMinor: line.amountMinor,
    confirmedAt: new Date().toISOString(),
    evidenceObservationId: line.identity,
  }),
  installmentIndex: match.installment.index,
});

const toEvidenceCandidate = (
  planMatch: PlanCandidate,
  installment: MsiInstallment,
): MsiEvidenceCandidate => ({
  eventId: planMatch.eventId,
  merchantRaw: planMatch.merchantRaw,
  plan: planMatch.plan,
  installment,
});

const resolveTargetInstallment = (
  plan: MsiPlan,
  line: EvidenceLine,
  month: string,
): MsiInstallment | undefined => {
  if (line.installmentIndex !== undefined) {
    return plan.installments.find((installment) => installment.index === line.installmentIndex);
  }
  return plan.installments.find(
    (installment) =>
      installment.month === month
      && amountsWithinTolerance(installment.amountMinor, line.amountMinor),
  );
};

const looksLikeMsiEvidence = (line: EvidenceLine): boolean =>
  line.installmentIndex !== undefined
  || line.installmentMonths !== undefined
  || line.originalAmountMinor !== undefined
  || isMsiLikeMerchant(line.merchantRaw)
  || isAutomaticAmexLabel(line.merchantRaw);

/**
 * Match statement/CSV MSI evidence to an existing complete plan.
 * Prefer calendar+index on committed cuotas; fall back to merchant+principal so
 * mid-schedule imports confirm instead of spawning duplicate plans.
 * Never invents a schedule — unmatched MSI requires an explicit apply decision.
 */
export const matchEvidenceLine = (
  line: EvidenceLine,
  events: readonly JsonObject[],
): EvidenceMatchResult => {
  const month = monthKeyInZone(new Date(`${line.occurredOn}T12:00:00Z`));
  const candidates = evidenceCandidatesFromEvents(events);

  const alreadyApplied = events.some((event) => {
    const plan = asMsiPlan(event.msi);
    return plan?.installments.some(
      (installment) =>
        installment.status === "spent" && installment.evidenceObservationId === line.identity,
    );
  });
  if (alreadyApplied) return { kind: "skip", reason: "already_confirmed" };

  const indexed = candidates.filter((candidate) => {
    if (candidate.installment.month !== month) return false;
    if (line.installmentIndex !== undefined && candidate.installment.index !== line.installmentIndex) {
      return false;
    }
    if (
      line.installmentMonths !== undefined
      && candidate.plan.months !== line.installmentMonths
    ) {
      return false;
    }
    if (!amountsWithinTolerance(candidate.installment.amountMinor, line.amountMinor)) return false;

    if (isAutomaticAmexLabel(line.merchantRaw)) {
      if (line.originalAmountMinor === undefined) return false;
      return amountsWithinTolerance(candidate.plan.principalMinor, line.originalAmountMinor);
    }

    if (
      line.originalAmountMinor !== undefined
      && !amountsWithinTolerance(candidate.plan.principalMinor, line.originalAmountMinor)
      && !amexMerchantsMatch(candidate.merchantRaw, line.merchantRaw)
    ) {
      return false;
    }
    return amexMerchantsMatch(candidate.merchantRaw, line.merchantRaw);
  });

  if (indexed.length === 1) return confirmMatch(indexed[0], line);
  if (indexed.length > 1) {
    return { kind: "needs_decision", reason: "ambiguous_msi_match", candidates: indexed };
  }

  // Calendar drifted (plan opened from a different cuota) — match the plan, then the index.
  const planMatches = matchingPlansForEvidence(line, events);
  if (planMatches.length > 1) {
    return {
      kind: "needs_decision",
      reason: "ambiguous_msi_match",
      candidates: planMatches.flatMap((planMatch) => {
        const installment = resolveTargetInstallment(planMatch.plan, line, month);
        return installment ? [toEvidenceCandidate(planMatch, installment)] : [];
      }),
    };
  }
  if (planMatches.length === 1) {
    const planMatch = planMatches[0];
    const installment = resolveTargetInstallment(planMatch.plan, line, month);
    if (!installment) {
      return { kind: "needs_decision", reason: "no_matching_plan", candidates: [] };
    }
    if (installment.status === "cancelled") {
      return { kind: "needs_decision", reason: "no_matching_plan", candidates: [] };
    }
    // Spent without this evidence still confirms so we attach the observation id
    // instead of opening a duplicate plan from an earlier statement.
    return confirmMatch(toEvidenceCandidate(planMatch, installment), line);
  }

  if (looksLikeMsiEvidence(line)) {
    return { kind: "needs_decision", reason: "no_matching_plan", candidates: [] };
  }
  return { kind: "skip", reason: "not_msi_evidence" };
};

/** True when the statement row has enough MSI schedule metadata to open a plan. */
export const canCreateMsiPlanFromEvidence = (
  line: Pick<EvidenceLine, "amountMinor" | "installmentIndex" | "installmentMonths" | "originalAmountMinor">,
  months?: number,
): boolean => {
  const resolvedMonths = months ?? line.installmentMonths;
  if (!resolvedMonths || resolvedMonths < 1 || line.amountMinor <= 0) return false;
  const index = line.installmentIndex ?? 1;
  return index >= 1 && index <= resolvedMonths;
};

/** Build a complete manual MSI plan from an explicit create_plan decision. */
export const buildPlanFromCreateDecision = (
  line: EvidenceLine,
  input: {
    readonly months: number;
    readonly cuotaMinor: number;
    readonly startMonth?: string;
  },
): MsiPlan => {
  if (!canCreateMsiPlanFromEvidence(line, input.months)) {
    throw new Error("Faltan meses o cuota para crear el plan MSI.");
  }
  const months = input.months;
  const cuotaMinor = input.cuotaMinor;
  let startMonth = input.startMonth;
  if (!startMonth) {
    const index = line.installmentIndex ?? 1;
    const startDate = new Date(`${line.occurredOn}T12:00:00Z`);
    startDate.setUTCMonth(startDate.getUTCMonth() - (index - 1));
    startMonth = monthKeyInZone(startDate);
  }
  const principalMinor = line.originalAmountMinor ?? cuotaMinor * months;
  const indexForSpent = line.installmentIndex ?? 1;
  const plan = buildMsiSchedule({
    principalMinor,
    months,
    startMonth,
    origin: isAutomaticAmexLabel(line.merchantRaw) ? "amex_auto" : "manual",
    cuotaMinor,
  });
  // Prior cuotas are assumed already paid on earlier statements — never leave them committed.
  const withPriorSpent: MsiPlan = {
    ...plan,
    installments: plan.installments.map((installment) =>
      installment.index < indexForSpent
        ? { ...installment, status: "spent" as const }
        : installment,
    ),
  };
  return markInstallmentSpent(withPriorSpent, indexForSpent, {
    amountMinor: line.amountMinor,
    confirmedAt: new Date().toISOString(),
    evidenceObservationId: line.identity,
  });
};

export const isSantanderMsiRow = (merchantRaw: string): boolean => isMsiLikeMerchant(merchantRaw);

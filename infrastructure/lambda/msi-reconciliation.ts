import {
  amountsWithinTolerance,
  buildMsiSchedule,
  isMsiLikeMerchant,
  markInstallmentSpent,
  monthKeyInZone,
  type MsiEvidenceCandidate,
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

const isAutomaticAmexLabel = (merchantRaw: string): boolean =>
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

const looksLikeMsiEvidence = (line: EvidenceLine): boolean =>
  line.installmentIndex !== undefined
  || line.installmentMonths !== undefined
  || line.originalAmountMinor !== undefined
  || isMsiLikeMerchant(line.merchantRaw)
  || isAutomaticAmexLabel(line.merchantRaw);

/**
 * Match statement/CSV MSI evidence to an existing complete plan.
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
  if (looksLikeMsiEvidence(line)) {
    return { kind: "needs_decision", reason: "no_matching_plan", candidates: [] };
  }
  return { kind: "skip", reason: "not_msi_evidence" };
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
    origin: "manual",
    cuotaMinor,
  });
  return markInstallmentSpent(plan, indexForSpent, {
    amountMinor: line.amountMinor,
    confirmedAt: new Date().toISOString(),
    evidenceObservationId: line.identity,
  });
};

export const isSantanderMsiRow = (merchantRaw: string): boolean => isMsiLikeMerchant(merchantRaw);

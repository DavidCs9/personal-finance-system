import {
  amountsWithinTolerance,
  buildMsiSchedule,
  findMsiEvidenceMatch,
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
      readonly kind: "unplanned";
      readonly plan: MsiPlan;
      readonly merchantRaw: string;
      readonly occurredOn: string;
      readonly amountMinor: number;
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
      line.installmentMonths !== undefined &&
      candidate.plan.months !== line.installmentMonths
    ) {
      return false;
    }
    if (!amountsWithinTolerance(candidate.installment.amountMinor, line.amountMinor)) return false;

    if (isAutomaticAmexLabel(line.merchantRaw)) {
      // Automatic labels omit the real merchant: principal (+ index/months/amount) must disambiguate.
      if (line.originalAmountMinor === undefined) return false;
      return amountsWithinTolerance(candidate.plan.principalMinor, line.originalAmountMinor);
    }

    if (
      line.originalAmountMinor !== undefined &&
      !amountsWithinTolerance(candidate.plan.principalMinor, line.originalAmountMinor) &&
      !amexMerchantsMatch(candidate.merchantRaw, line.merchantRaw)
    ) {
      return false;
    }
    return amexMerchantsMatch(candidate.merchantRaw, line.merchantRaw);
  });

  if (indexed.length === 1) return confirmMatch(indexed[0], line);
  if (indexed.length > 1) return { kind: "skip", reason: "ambiguous_msi_match" };

  if (!isAutomaticAmexLabel(line.merchantRaw)) {
    const loose = findMsiEvidenceMatch(candidates, {
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      month,
      merchantsMatch: amexMerchantsMatch,
    });
    if (loose) return confirmMatch(loose, line);
  }

  if (line.installmentIndex !== undefined || isMsiLikeMerchant(line.merchantRaw) || line.originalAmountMinor) {
    const months = line.installmentMonths ?? 3;
    const principalMinor = line.originalAmountMinor ?? line.amountMinor * months;
    const startOffset = (line.installmentIndex ?? 1) - 1;
    const startDate = new Date(`${line.occurredOn}T12:00:00Z`);
    startDate.setUTCMonth(startDate.getUTCMonth() - startOffset);
    const startMonth = monthKeyInZone(startDate);
    const plan = markInstallmentSpent(
      buildMsiSchedule({
        principalMinor,
        months,
        startMonth,
        origin: "statement_unplanned",
        cuotaMinor: line.amountMinor,
        needsScheduleCompletion: true,
      }),
      line.installmentIndex ?? 1,
      {
        amountMinor: line.amountMinor,
        confirmedAt: new Date().toISOString(),
        evidenceObservationId: line.identity,
      },
    );
    return {
      kind: "unplanned",
      merchantRaw: line.merchantRaw,
      occurredOn: line.occurredOn,
      amountMinor: line.amountMinor,
      plan: { ...plan, needsScheduleCompletion: true, origin: "statement_unplanned" },
    };
  }

  return { kind: "skip", reason: "not_msi_evidence" };
};

export const isSantanderMsiRow = (merchantRaw: string): boolean => isMsiLikeMerchant(merchantRaw);

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

const amexMerchantsMatch = (left: string, right: string): boolean => {
  if (/MESES EN AUTOM[AÁ]TICO/i.test(left) || /MESES EN AUTOM[AÁ]TICO/i.test(right)) {
    return true;
  }
  return santanderMerchantsMatch(left, right);
};

export const matchEvidenceLine = (
  line: EvidenceLine,
  events: readonly JsonObject[],
): EvidenceMatchResult => {
  const month = monthKeyInZone(new Date(`${line.occurredOn}T12:00:00Z`));
  const candidates = evidenceCandidatesFromEvents(events);

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
    if (
      line.originalAmountMinor !== undefined &&
      !amountsWithinTolerance(candidate.plan.principalMinor, line.originalAmountMinor)
    ) {
      // Keep as soft signal; automatic Amex labels often omit merchant.
      if (!/MESES EN AUTOM[AÁ]TICO/i.test(line.merchantRaw)) return false;
    }
    if (!amountsWithinTolerance(candidate.installment.amountMinor, line.amountMinor)) return false;
    if (/MESES EN AUTOM[AÁ]TICO/i.test(line.merchantRaw)) {
      return line.originalAmountMinor === undefined
        || amountsWithinTolerance(candidate.plan.principalMinor, line.originalAmountMinor);
    }
    return amexMerchantsMatch(candidate.merchantRaw, line.merchantRaw);
  });

  if (indexed.length === 1) {
    const match = indexed[0];
    return {
      kind: "confirm",
      eventId: match.eventId,
      previous: match.plan,
      next: markInstallmentSpent(match.plan, match.installment.index, {
        amountMinor: line.amountMinor,
        confirmedAt: new Date().toISOString(),
        evidenceObservationId: line.identity,
      }),
      installmentIndex: match.installment.index,
    };
  }

  const loose = findMsiEvidenceMatch(candidates, {
    merchantRaw: line.merchantRaw,
    amountMinor: line.amountMinor,
    month,
    merchantsMatch: amexMerchantsMatch,
  });
  if (loose) {
    return {
      kind: "confirm",
      eventId: loose.eventId,
      previous: loose.plan,
      next: markInstallmentSpent(loose.plan, loose.installment.index, {
        amountMinor: line.amountMinor,
        confirmedAt: new Date().toISOString(),
        evidenceObservationId: line.identity,
      }),
      installmentIndex: loose.installment.index,
    };
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

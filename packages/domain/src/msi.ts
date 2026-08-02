import { monthKeyInZone } from "./month-summary.js";

export const AMEX_AUTO_MSI_THRESHOLD_MINOR = 250_000;
export const MSI_AMOUNT_TOLERANCE_MINOR = 200;
export const AMEX_AUTO_MSI_MONTHS = 3;

export type MsiOrigin = "amex_auto" | "manual" | "statement_unplanned";
export type InstallmentStatus = "committed" | "spent" | "cancelled";
export type MsiPlanStatus = "active" | "completed" | "cancelled";

export interface MsiInstallment {
  readonly index: number;
  readonly month: string;
  readonly amountMinor: number;
  readonly status: InstallmentStatus;
  readonly evidenceObservationId?: string;
  readonly confirmedAt?: string;
}

export interface MsiPlan {
  readonly months: number;
  readonly cuotaMinor: number;
  readonly principalMinor: number;
  readonly origin: MsiOrigin;
  readonly status: MsiPlanStatus;
  readonly installments: readonly MsiInstallment[];
  readonly needsScheduleCompletion?: boolean;
}

export interface MsiScheduleInput {
  readonly principalMinor: number;
  readonly months: number;
  readonly startMonth: string;
  readonly origin: MsiOrigin;
  readonly cuotaMinor?: number;
  readonly needsScheduleCompletion?: boolean;
}

export const amountsWithinTolerance = (
  leftMinor: number,
  rightMinor: number,
  toleranceMinor: number = MSI_AMOUNT_TOLERANCE_MINOR,
): boolean => Math.abs(leftMinor - rightMinor) <= toleranceMinor;

export const addCalendarMonths = (month: string, offset: number): string => {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1 + offset;
  const date = new Date(Date.UTC(year, monthIndex, 1));
  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${nextYear}-${nextMonth}`;
};

export const defaultCuotaMinor = (principalMinor: number, months: number): number => {
  if (!Number.isInteger(months) || months < 1) {
    throw new Error("MSI months must be a positive integer.");
  }
  if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) {
    throw new Error("MSI principal must be a positive integer amount.");
  }
  return Math.round(principalMinor / months);
};

export const buildMsiSchedule = (input: MsiScheduleInput): MsiPlan => {
  const months = input.months;
  if (!Number.isInteger(months) || months < 1 || months > 48) {
    throw new Error("MSI months must be between 1 and 48.");
  }
  if (!/^\d{4}-\d{2}$/.test(input.startMonth)) {
    throw new Error("MSI start month must use YYYY-MM format.");
  }
  const cuotaMinor = input.cuotaMinor ?? defaultCuotaMinor(input.principalMinor, months);
  if (!Number.isSafeInteger(cuotaMinor) || cuotaMinor <= 0) {
    throw new Error("MSI cuota must be a positive integer amount.");
  }

  const installments: MsiInstallment[] = Array.from({ length: months }, (_, index) => ({
    index: index + 1,
    month: addCalendarMonths(input.startMonth, index),
    amountMinor: cuotaMinor,
    status: "committed" as const,
  }));

  return {
    months,
    cuotaMinor,
    principalMinor: input.principalMinor,
    origin: input.origin,
    status: "active",
    installments,
    ...(input.needsScheduleCompletion ? { needsScheduleCompletion: true } : {}),
  };
};

export const maybeAutoAmexMsi = (input: {
  readonly institution: string;
  readonly amountMinor: number;
  readonly occurredAt?: string;
  readonly receivedAt: string;
}): MsiPlan | undefined => {
  if (input.institution !== "american_express_mx") return undefined;
  if (!(input.amountMinor > AMEX_AUTO_MSI_THRESHOLD_MINOR)) return undefined;
  const startMonth = monthKeyInZone(new Date(input.occurredAt ?? input.receivedAt));
  return buildMsiSchedule({
    principalMinor: input.amountMinor,
    months: AMEX_AUTO_MSI_MONTHS,
    startMonth,
    origin: "amex_auto",
  });
};

export const msiLabel = (merchantRaw: string, installment: Pick<MsiInstallment, "index">, months: number): string =>
  `${merchantRaw} · MSI ${installment.index}/${months}`;

export const cancelRemainingInstallments = (plan: MsiPlan): MsiPlan => {
  const installments = plan.installments.map((installment) =>
    installment.status === "committed"
      ? { ...installment, status: "cancelled" as const }
      : installment,
  );
  const hasActive = installments.some((installment) => installment.status !== "cancelled");
  return {
    ...plan,
    status: hasActive && installments.some((item) => item.status === "spent") ? "completed" : "cancelled",
    installments,
    needsScheduleCompletion: undefined,
  };
};

export const markInstallmentSpent = (
  plan: MsiPlan,
  index: number,
  input: {
    readonly amountMinor: number;
    readonly evidenceObservationId?: string;
    readonly confirmedAt: string;
  },
): MsiPlan => {
  const installments = plan.installments.map((installment) => {
    if (installment.index !== index) return installment;
    return {
      ...installment,
      amountMinor: input.amountMinor,
      status: "spent" as const,
      evidenceObservationId: input.evidenceObservationId,
      confirmedAt: input.confirmedAt,
    };
  });
  const allTerminal = installments.every(
    (installment) => installment.status === "spent" || installment.status === "cancelled",
  );
  return {
    ...plan,
    cuotaMinor: input.amountMinor,
    status: allTerminal ? "completed" : plan.status,
    installments,
    needsScheduleCompletion: undefined,
  };
};

const preserveTerminalInstallments = (
  previous: MsiPlan | undefined,
  rebuilt: MsiPlan,
): MsiPlan => {
  if (!previous) return rebuilt;
  const spentByIndex = new Map(
    previous.installments
      .filter((installment) => installment.status === "spent")
      .map((installment) => [installment.index, installment]),
  );
  const spentByMonth = new Map(
    previous.installments
      .filter((installment) => installment.status === "spent")
      .map((installment) => [installment.month, installment]),
  );
  const installments = rebuilt.installments.map((installment) => {
    const spent = spentByIndex.get(installment.index) ?? spentByMonth.get(installment.month);
    return spent
      ? {
          ...installment,
          amountMinor: spent.amountMinor,
          status: "spent" as const,
          evidenceObservationId: spent.evidenceObservationId,
          confirmedAt: spent.confirmedAt,
        }
      : installment;
  });
  const allTerminal = installments.every(
    (installment) => installment.status === "spent" || installment.status === "cancelled",
  );
  return {
    ...rebuilt,
    installments,
    status: allTerminal ? "completed" : rebuilt.status,
    needsScheduleCompletion: undefined,
  };
};

export const replaceMsiSchedule = (
  previous: MsiPlan | undefined,
  input: MsiScheduleInput,
): MsiPlan => preserveTerminalInstallments(previous, buildMsiSchedule(input));

export const completeUnplannedSchedule = (
  plan: MsiPlan,
  input: {
    readonly months: number;
    readonly cuotaMinor?: number;
    readonly startMonth: string;
  },
): MsiPlan =>
  replaceMsiSchedule(plan, {
    principalMinor: plan.principalMinor,
    months: input.months,
    startMonth: input.startMonth,
    origin: plan.origin === "statement_unplanned" ? "manual" : plan.origin,
    cuotaMinor: input.cuotaMinor,
  });

export interface MsiEvidenceCandidate {
  readonly eventId: string;
  readonly merchantRaw: string;
  readonly plan: MsiPlan;
  readonly installment: MsiInstallment;
}

export const findMsiEvidenceMatch = (
  candidates: readonly MsiEvidenceCandidate[],
  input: {
    readonly merchantRaw: string;
    readonly amountMinor: number;
    readonly month: string;
    readonly merchantsMatch: (left: string, right: string) => boolean;
  },
): MsiEvidenceCandidate | undefined => {
  const matches = candidates.filter(
    (candidate) =>
      candidate.installment.month === input.month &&
      candidate.installment.status === "committed" &&
      input.merchantsMatch(candidate.merchantRaw, input.merchantRaw) &&
      amountsWithinTolerance(candidate.installment.amountMinor, input.amountMinor),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

export const isMsiLikeMerchant = (merchantRaw: string): boolean =>
  /\bA\s*MESES\b/i.test(merchantRaw) || /\bMSI\b/i.test(merchantRaw) || /\bMESES\s+SIN\s+INTERESES\b/i.test(merchantRaw);

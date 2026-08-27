import type { MsiInstallment, MsiPlan } from "./msi.js";
import { msiLabel } from "./msi.js";

export const FINANCE_TIME_ZONE = "America/Chihuahua";

/** Rejected, deferred MSI, and foreign authorizations awaiting the posted MXN charge do not inflate Has gastado. */
export const countsTowardMonthSpend = (status: string): boolean =>
  status !== "rejected" && status !== "deferred_msi" && status !== "pending_foreign";

export interface MonthSpendEvent {
  readonly id?: string;
  readonly amountMinor: number;
  /** Owner-attributed spend for shared, non-MSI purchases. Absent means the full amount. */
  readonly personalAmountMinor?: number;
  readonly status: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly merchantRaw?: string;
  readonly msi?: Pick<
    MsiPlan,
    "months" | "installments" | "needsScheduleCompletion" | "principalMinor" | "cuotaMinor"
  >;
}

export interface MonthSummaryInput {
  readonly events: readonly MonthSpendEvent[];
  readonly month: string;
  readonly incomeMinor: number;
  readonly incomeConfigured: boolean;
  readonly upcomingPaymentsMinor: number;
  readonly now: Date;
}

export interface CommittedMsiRow {
  readonly eventId?: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly installmentIndex: number;
  readonly months: number;
  readonly merchantRaw: string;
}

export interface MonthMsiRow extends CommittedMsiRow {
  readonly status: "spent" | "committed";
  /** First installment month of the finite plan. */
  readonly startMonth: string;
  /** Last installment month of the finite plan. */
  readonly endMonth: string;
  readonly principalMinor: number;
  readonly cuotaMinor: number;
}

export interface MonthSummary {
  readonly month: string;
  readonly spentMinor: number;
  readonly discretionarySpentMinor: number;
  readonly msiSpentMinor: number;
  readonly uncertainMinor: number;
  readonly upcomingMinor: number;
  readonly billUpcomingMinor: number;
  readonly msiCommittedMinor: number;
  readonly remainingMinor: number;
  readonly projectedSpendMinor: number;
  readonly projectedRemainingMinor: number;
  readonly incomeConfigured: boolean;
  readonly incomeMinor: number;
  readonly isCurrentMonth: boolean;
  readonly daysInMonth: number;
  readonly elapsedDays: number;
  readonly committedMsiRows: readonly CommittedMsiRow[];
  /** Spent and committed cuotas for the selected month (UI MSI section). */
  readonly monthMsiRows: readonly MonthMsiRow[];
}

export type PushContentMode = "amounts" | "private";

export interface DailyBalancePushMessage {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly navigate: string;
}

export const monthKeyInZone = (date: Date, timeZone: string = FINANCE_TIME_ZONE): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone,
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
};

export const dayKeyInZone = (date: Date, timeZone: string = FINANCE_TIME_ZONE): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

export const dayInZone = (date: Date, timeZone: string = FINANCE_TIME_ZONE): number =>
  Number(new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone }).format(date));

export const daysInCalendarMonth = (month: string): number =>
  new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();

export const eventMonthKey = (event: Pick<MonthSpendEvent, "occurredAt" | "receivedAt">): string =>
  monthKeyInZone(new Date(event.occurredAt ?? event.receivedAt));

/** Amount attributed to the owner while preserving amountMinor as the observed bank total. */
export const personalSpendAmountMinor = (
  event: Pick<MonthSpendEvent, "amountMinor" | "personalAmountMinor">,
): number => event.personalAmountMinor ?? event.amountMinor;

export const formatMxnWhole = (amountMinor: number): string =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);

const installmentAmountFor = (
  events: readonly MonthSpendEvent[],
  month: string,
  status: MsiInstallment["status"],
): number =>
  events.reduce((sum, event) => {
    if (!countsTowardMonthSpend(event.status) || !event.msi) return sum;
    // Incomplete stubs must not pollute committed totals.
    if (status === "committed" && event.msi.needsScheduleCompletion) return sum;
    return (
      sum +
      event.msi.installments
        .filter((installment) => installment.month === month && installment.status === status)
        .reduce((inner, installment) => inner + installment.amountMinor, 0)
    );
  }, 0);

export const listMonthMsiRows = (
  events: readonly (MonthSpendEvent & { readonly id?: string })[],
  month: string,
): readonly MonthMsiRow[] => {
  const rows: MonthMsiRow[] = [];
  for (const event of events) {
    if (!countsTowardMonthSpend(event.status) || !event.msi) continue;
    const schedule = [...event.msi.installments].sort((left, right) => left.index - right.index);
    const startMonth = schedule[0]?.month;
    const endMonth = schedule[schedule.length - 1]?.month;
    if (!startMonth || !endMonth) continue;
    for (const installment of event.msi.installments) {
      if (installment.month !== month) continue;
      if (installment.status !== "spent" && installment.status !== "committed") continue;
      // Incomplete stubs must not appear as pending commitments.
      if (installment.status === "committed" && event.msi.needsScheduleCompletion) continue;
      const merchantRaw = event.merchantRaw ?? "Compra";
      rows.push({
        eventId: event.id,
        name: msiLabel(merchantRaw, installment, event.msi.months),
        amountMinor: installment.amountMinor,
        installmentIndex: installment.index,
        months: event.msi.months,
        merchantRaw,
        status: installment.status,
        startMonth,
        endMonth,
        principalMinor: event.msi.principalMinor,
        cuotaMinor: event.msi.cuotaMinor,
      });
    }
  }
  return rows.sort((left, right) => {
    if (left.status !== right.status) return left.status === "committed" ? -1 : 1;
    return left.name.localeCompare(right.name, "es");
  });
};

export const listCommittedMsiRows = (
  events: readonly (MonthSpendEvent & { readonly id?: string })[],
  month: string,
): readonly CommittedMsiRow[] =>
  listMonthMsiRows(events, month)
    .filter((row) => row.status === "committed")
    .map(
      ({
        status: _status,
        startMonth: _startMonth,
        endMonth: _endMonth,
        principalMinor: _principalMinor,
        cuotaMinor: _cuotaMinor,
        ...row
      }) => row,
    );

export const computeMonthSummary = (input: MonthSummaryInput): MonthSummary => {
  const activeEvents = input.events.filter((event) => countsTowardMonthSpend(event.status));
  let discretionarySpentMinor = 0;
  let uncertainMinor = 0;

  for (const event of activeEvents) {
    if (event.msi) {
      if (event.status !== "needs_review") continue;
      const spentThisMonth = event.msi.installments
        .filter((installment) => installment.month === input.month && installment.status === "spent")
        .reduce((sum, installment) => sum + installment.amountMinor, 0);
      uncertainMinor += spentThisMonth;
      continue;
    }
    if (eventMonthKey(event) !== input.month) continue;
    const amountMinor = personalSpendAmountMinor(event);
    discretionarySpentMinor += amountMinor;
    if (event.status === "needs_review") uncertainMinor += amountMinor;
  }

  const msiSpentMinor = installmentAmountFor(activeEvents, input.month, "spent");
  const msiCommittedMinor = installmentAmountFor(activeEvents, input.month, "committed");
  const spentMinor = discretionarySpentMinor + msiSpentMinor;
  const billUpcomingMinor = input.upcomingPaymentsMinor;
  const upcomingMinor = billUpcomingMinor + msiCommittedMinor;
  const remainingMinor = input.incomeMinor - spentMinor - upcomingMinor;
  const isCurrentMonth = input.month === monthKeyInZone(input.now);
  const daysInMonth = daysInCalendarMonth(input.month);
  const elapsedDays = isCurrentMonth ? dayInZone(input.now) : daysInMonth;
  const pacedDiscretionaryMinor = Math.round(
    (discretionarySpentMinor / Math.max(elapsedDays, 1)) * daysInMonth,
  );
  const projectedSpendMinor = pacedDiscretionaryMinor + msiSpentMinor + upcomingMinor;
  const projectedRemainingMinor = input.incomeMinor - projectedSpendMinor;

  return {
    month: input.month,
    spentMinor,
    discretionarySpentMinor,
    msiSpentMinor,
    uncertainMinor,
    upcomingMinor,
    billUpcomingMinor,
    msiCommittedMinor,
    remainingMinor,
    projectedSpendMinor,
    projectedRemainingMinor,
    incomeConfigured: input.incomeConfigured,
    incomeMinor: input.incomeMinor,
    isCurrentMonth,
    daysInMonth,
    elapsedDays,
    committedMsiRows: listCommittedMsiRows(activeEvents, input.month),
    monthMsiRows: listMonthMsiRows(activeEvents, input.month),
  };
};

export const dailyBalancePushMessage = (
  summary: MonthSummary,
  contentMode: PushContentMode,
  navigateUrl: string,
  dayKey: string,
): DailyBalancePushMessage => {
  const tag = `daily-${dayKey}`;
  if (contentMode === "private") {
    return {
      title: "Olbia",
      body: "Tu balance diario está listo.",
      tag,
      navigate: navigateUrl,
    };
  }

  const spent = formatMxnWhole(summary.spentMinor);
  if (!summary.incomeConfigured || summary.incomeMinor <= 0) {
    return {
      title: "Olbia · balance de hoy",
      body: `Has gastado ${spent} este mes. Sube la nómina del mes para ver qué te queda.`,
      tag,
      navigate: navigateUrl,
    };
  }

  const remaining = formatMxnWhole(Math.max(summary.remainingMinor, 0));
  const parts = [
    `Has gastado ${spent} este mes.`,
    `Te quedan ${remaining} después de compromisos.`,
  ];

  if (summary.projectedRemainingMinor < 0) {
    parts.push(`A este ritmo gastarás ${formatMxnWhole(summary.projectedSpendMinor)}.`);
  } else if (summary.uncertainMinor > 0) {
    parts.push(`Incluye ${formatMxnWhole(summary.uncertainMinor)} por confirmar.`);
  }

  return {
    title: "Olbia · balance de hoy",
    body: parts.join(" "),
    tag,
    navigate: navigateUrl,
  };
};

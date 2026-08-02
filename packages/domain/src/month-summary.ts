import type { MsiInstallment, MsiPlan } from "./msi.js";
import { msiLabel } from "./msi.js";

export const FINANCE_TIME_ZONE = "America/Chihuahua";

export interface MonthSpendEvent {
  readonly id?: string;
  readonly amountMinor: number;
  readonly status: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly merchantRaw?: string;
  readonly msi?: Pick<MsiPlan, "months" | "installments" | "needsScheduleCompletion">;
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
  readonly projectedRemainingMinor: number;
  readonly incomeConfigured: boolean;
  readonly incomeMinor: number;
  readonly isCurrentMonth: boolean;
  readonly daysInMonth: number;
  readonly elapsedDays: number;
  readonly committedMsiRows: readonly CommittedMsiRow[];
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
    if (event.status === "rejected" || !event.msi) return sum;
    // Incomplete stubs must not pollute committed totals.
    if (status === "committed" && event.msi.needsScheduleCompletion) return sum;
    return (
      sum +
      event.msi.installments
        .filter((installment) => installment.month === month && installment.status === status)
        .reduce((inner, installment) => inner + installment.amountMinor, 0)
    );
  }, 0);

export const listCommittedMsiRows = (
  events: readonly (MonthSpendEvent & { readonly id?: string })[],
  month: string,
): readonly CommittedMsiRow[] => {
  const rows: CommittedMsiRow[] = [];
  for (const event of events) {
    if (event.status === "rejected" || !event.msi) continue;
    if (event.msi.needsScheduleCompletion) continue;
    for (const installment of event.msi.installments) {
      if (installment.month !== month || installment.status !== "committed") continue;
      const merchantRaw = event.merchantRaw ?? "Compra";
      rows.push({
        eventId: event.id,
        name: msiLabel(merchantRaw, installment, event.msi.months),
        amountMinor: installment.amountMinor,
        installmentIndex: installment.index,
        months: event.msi.months,
        merchantRaw,
      });
    }
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name, "es"));
};

export const computeMonthSummary = (input: MonthSummaryInput): MonthSummary => {
  const activeEvents = input.events.filter((event) => event.status !== "rejected");
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
    discretionarySpentMinor += event.amountMinor;
    if (event.status === "needs_review") uncertainMinor += event.amountMinor;
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
  const projectedMinor = pacedDiscretionaryMinor + msiSpentMinor + upcomingMinor;
  const projectedRemainingMinor = input.incomeMinor - projectedMinor;

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
    projectedRemainingMinor,
    incomeConfigured: input.incomeConfigured,
    incomeMinor: input.incomeMinor,
    isCurrentMonth,
    daysInMonth,
    elapsedDays,
    committedMsiRows: listCommittedMsiRows(activeEvents, input.month),
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
      body: `Has gastado ${spent} este mes. Configura el ingreso del mes para ver qué te queda.`,
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
    parts.push(`A este ritmo te faltarán ${formatMxnWhole(Math.abs(summary.projectedRemainingMinor))}.`);
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

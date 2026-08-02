export const FINANCE_TIME_ZONE = "America/Chihuahua";

export interface MonthSpendEvent {
  readonly amountMinor: number;
  readonly status: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
}

export interface MonthSummaryInput {
  readonly events: readonly MonthSpendEvent[];
  readonly month: string;
  readonly incomeMinor: number;
  readonly incomeConfigured: boolean;
  readonly upcomingPaymentsMinor: number;
  readonly now: Date;
}

export interface MonthSummary {
  readonly month: string;
  readonly spentMinor: number;
  readonly uncertainMinor: number;
  readonly upcomingMinor: number;
  readonly remainingMinor: number;
  readonly projectedRemainingMinor: number;
  readonly incomeConfigured: boolean;
  readonly incomeMinor: number;
  readonly isCurrentMonth: boolean;
  readonly daysInMonth: number;
  readonly elapsedDays: number;
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

export const computeMonthSummary = (input: MonthSummaryInput): MonthSummary => {
  const monthEvents = input.events.filter((event) => eventMonthKey(event) === input.month);
  const spendEvents = monthEvents.filter((event) => event.status !== "rejected");
  const spentMinor = spendEvents.reduce((sum, event) => sum + event.amountMinor, 0);
  const uncertainMinor = spendEvents
    .filter((event) => event.status === "needs_review")
    .reduce((sum, event) => sum + event.amountMinor, 0);
  const upcomingMinor = input.upcomingPaymentsMinor;
  const remainingMinor = input.incomeMinor - spentMinor - upcomingMinor;
  const isCurrentMonth = input.month === monthKeyInZone(input.now);
  const daysInMonth = daysInCalendarMonth(input.month);
  const elapsedDays = isCurrentMonth ? dayInZone(input.now) : daysInMonth;
  const projectedMinor =
    Math.round((spentMinor / Math.max(elapsedDays, 1)) * daysInMonth) + upcomingMinor;
  const projectedRemainingMinor = input.incomeMinor - projectedMinor;

  return {
    month: input.month,
    spentMinor,
    uncertainMinor,
    upcomingMinor,
    remainingMinor,
    projectedRemainingMinor,
    incomeConfigured: input.incomeConfigured,
    incomeMinor: input.incomeMinor,
    isCurrentMonth,
    daysInMonth,
    elapsedDays,
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

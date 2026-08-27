import type { PurchaseEvent, ReviewStatus } from "../types";
import { FINANCE_TIME_ZONE, dayInZone as dayInZoneShared, formatMxnWhole, monthKeyInZone } from "@finance/domain";

export const timeZone = FINANCE_TIME_ZONE;

const dateFormatter = new Intl.DateTimeFormat("es-MX", {
  day: "numeric",
  month: "short",
  timeZone,
});

const timeFormatter = new Intl.DateTimeFormat("es-MX", {
  hour: "numeric",
  minute: "2-digit",
  timeZone,
});

export const longDateFormatter = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone,
});

const longDayFormatter = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "long",
  timeZone,
});

export const monthFormatter = new Intl.DateTimeFormat("es-MX", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export const institutionLabel = (value: PurchaseEvent["institution"]) =>
  value === "american_express_mx"
    ? "American Express"
    : value === "santander_mx"
      ? "Santander"
      : value === "nu_mx"
        ? "Nu"
        : "AWS";

export const statusLabel: Record<ReviewStatus, string> = {
  accepted: "Confirmado",
  needs_review: "Por confirmar",
  rejected: "Rechazado",
  deferred_msi: "Diferido a MSI",
  pending_foreign: "Esperando cargo MXN",
};

export const money = (amountMinor: number) => formatMxnWhole(amountMinor);

/** Amount shown in Movimientos for the selected month (MSI → that month's cuota, else principal). */
export const movementAmountMinor = (event: PurchaseEvent, month: string): number => {
  const installment = event.msi?.installments.find((item) => item.month === month);
  if (installment) return installment.amountMinor;
  return event.personalAmountMinor ?? event.amount.amountMinor;
};

/** Rejected events remain available through the API/DB for audit but stay out of the normal UI. */
export const visibleMovementEvents = (events: readonly PurchaseEvent[]): readonly PurchaseEvent[] =>
  events.filter((event) => event.status !== "rejected");

export const eventMoney = (event: PurchaseEvent) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: event.amount.currency,
  }).format(event.amount.amountMinor / 100);

export const movementMoney = (event: PurchaseEvent, month: string) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: event.amount.currency,
  }).format(movementAmountMinor(event, month) / 100);

const dateOnlyOccurredAt = /^\d{4}-\d{2}-\d{2}T12:00:00(?:\.000)?Z$/;

/**
 * Date-only bank evidence uses noon UTC as a sentinel so its calendar day remains stable.
 * When that sentinel is present, Olbia keeps the bank day but shows the time when the
 * movement was registered in the system instead of presenting 6:00 a.m. as observed fact.
 */
export const eventDate = (event: PurchaseEvent) =>
  new Date(event.occurredAt ?? event.ingestedAt ?? event.receivedAt);

export const eventTime = (event: PurchaseEvent) =>
  new Date(
    !event.occurredAt || dateOnlyOccurredAt.test(event.occurredAt)
      ? event.ingestedAt ?? event.receivedAt
      : event.occurredAt,
  );

export const eventDateLabel = (event: PurchaseEvent) =>
  `${dateFormatter.format(eventDate(event))}, ${timeFormatter.format(eventTime(event))}`;

export const longEventDateLabel = (event: PurchaseEvent) =>
  `${longDayFormatter.format(eventDate(event))}, ${timeFormatter.format(eventTime(event))}`;

const zonedClockKey = (date: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("hour")}${part("minute")}${part("second")}`;
};

/** Calendar-day + effective-clock key used by the "Más recientes" sort. */
export const eventRecencyKey = (event: PurchaseEvent): string =>
  `${monthKeyInZone(eventDate(event))}-${String(dayInZoneShared(eventDate(event))).padStart(2, "0")}T${zonedClockKey(eventTime(event))}`;

export const monthDate = (month: string) => new Date(`${month}-01T12:00:00Z`);

/** Short calendar label for a YYYY-MM key, e.g. "ago 2026". */
export const monthKeyLabel = (month: string) =>
  new Intl.DateTimeFormat("es-MX", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(monthDate(month))
    .replace(".", "");

export const monthKey = (date: Date) => monthKeyInZone(date);

export const dayInZone = (date: Date) => dayInZoneShared(date);

import type { PurchaseEvent, ReviewStatus } from "../types";
import { FINANCE_TIME_ZONE, dayInZone as dayInZoneShared, formatMxnWhole, monthKeyInZone } from "@finance/domain";

export const timeZone = FINANCE_TIME_ZONE;

export const dateFormatter = new Intl.DateTimeFormat("es-MX", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone,
});

export const longDateFormatter = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "long",
  timeStyle: "short",
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

export const eventDate = (event: PurchaseEvent) => new Date(event.occurredAt ?? event.receivedAt);

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

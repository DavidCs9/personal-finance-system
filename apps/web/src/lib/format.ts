import type { PurchaseEvent, ReviewStatus } from "../types";

export const timeZone = "America/Chihuahua";

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

const moneyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
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
};

export const money = (amountMinor: number) => moneyFormatter.format(amountMinor / 100);

export const eventMoney = (event: PurchaseEvent) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: event.amount.currency,
  }).format(event.amount.amountMinor / 100);

export const eventDate = (event: PurchaseEvent) => new Date(event.occurredAt ?? event.receivedAt);

export const monthDate = (month: string) => new Date(`${month}-01T12:00:00Z`);

export const monthKey = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone,
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
};

export const dayInZone = (date: Date) =>
  Number(new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone }).format(date));

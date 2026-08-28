import {
  DEFAULT_SPEND_CATEGORIES,
  aggregateSpendByCategory,
  aggregateSpendByMerchant,
  aggregateSpendByTag,
  buildMsiSchedule,
  compareSpendBuckets,
  computeMonthSummary,
  dayInZone,
  daysInCalendarMonth,
  monthKeyInZone,
  monthOnlySpendAmountForMonth,
  previousCalendarMonth,
  uncertainAmountForMonth,
  type CategorizedSpendEvent,
  type MonthSummary,
  type SpendingAnalytics,
} from "@finance/domain";
import type { MonthlyPlan } from "../monthly-plan";
import type { EventFeed, IngestionException, PurchaseEvent } from "../types";

const source = (key: string) => ({
  bucket: "finance-raw-source-demo",
  key,
  sha256: "9f3e2b7c1a...demo-only",
  contentType: "message/rfc822" as const,
});

const rawEmail = (from: string, subject: string, body: string) => `From: ${from}
To: finance-inbox@example.test
Subject: ${subject}
Date: Sun, 12 Jul 2026 13:42:00 +0000
Message-ID: <demo-${subject.replaceAll(" ", "-").toLowerCase()}@example.test>

${body}`;

const spendMonth = (event: PurchaseEvent): string =>
  monthKeyInZone(new Date(event.occurredAt ?? event.receivedAt));

/** All mock purchases; served sliced per month via `mockFeedForMonth`. */
export const mockEvents: readonly PurchaseEvent[] = [
  {
    id: "evt_demo_usd_pending",
    institution: "santander_mx",
    status: "pending_foreign",
    accountName: "Santander LikeU",
    amount: { amountMinor: 1928, currency: "USD" },
    merchantRaw: "TARGET",
    occurredAt: "2026-08-22T21:30:00Z",
    receivedAt: "2026-08-22T21:30:02Z",
    ingestedAt: "2026-08-22T21:30:02Z",
    parserVersion: "apple-pay-shortcut-v2",
    source: {
      kind: "apple_pay_shortcut",
      requestId: "demo-usd-capture",
      cardRaw: "Santander LikeU",
      amountRaw: "$19.28",
      currency: "USD",
    },
    captureSource: "apple_pay_shortcut",
    captureSources: ["apple_pay_shortcut"],
    parseWarnings: [],
    revisions: [],
  },
  {
    id: "evt_01J5A0A1",
    institution: "american_express_mx",
    status: "accepted",
    accountName: "Tarjeta personal • 1234",
    amount: { amountMinor: 48500, currency: "MXN" },
    personalAmountMinor: 16200,
    merchantRaw: "CAFÉ DEL PARQUE CDMX",
    categoryId: "restaurantes",
    tags: ["trabajo", "viaje:cdmx"],
    occurredAt: "2026-07-12T13:38:00Z",
    receivedAt: "2026-07-12T13:42:00Z",
    ingestedAt: "2026-07-12T13:42:09Z",
    parserVersion: "amex-mx@0.1.0",
    source: source("2026/07/12/evt_01J5A0A1.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "American Express <alerts@example.test>",
      "Compra aprobada",
      "Se registró una compra por $485.00 MXN en CAFÉ DEL PARQUE CDMX.\nTarjeta terminación 1234.",
    ),
    revisions: [],
  },
  {
    id: "evt_01J5A0A2",
    institution: "santander_mx",
    status: "needs_review",
    accountName: "Tarjeta viajes • 8192",
    amount: { amountMinor: 124900, currency: "MXN" },
    merchantRaw: "RESERVA SERVICIOS ONLINE",
    categoryId: "viajes",
    occurredAt: "2026-07-12T09:15:00Z",
    receivedAt: "2026-07-12T09:17:00Z",
    ingestedAt: "2026-07-12T09:17:14Z",
    parserVersion: "santander-mx@0.1.0",
    source: source("2026/07/12/evt_01J5A0A2.eml"),
    parseWarnings: [
      "El comercio se extrajo, pero el formato de hora no coincide con la plantilla conocida.",
    ],
    rawEmail: rawEmail(
      "Santander Alertas <alerts@example.test>",
      "Aviso de compra",
      "Detectamos una compra por $1,249.00 MXN.\nComercio: RESERVA SERVICIOS ONLINE\nTarjeta terminación 8192.",
    ),
    revisions: [
      {
        id: "rev_01J5A0B1",
        observedPurchaseId: "evt_01J5A0A2",
        createdAt: "2026-07-12T10:03:00Z",
        changedBy: "owner@example.test",
        reason: "Confirmé que la compra pertenece a esta tarjeta.",
        changes: { account: { previous: "Sin confirmar", next: "Tarjeta viajes • 8192" } },
      },
    ],
  },
  {
    id: "evt_01J59ZZ9",
    institution: "american_express_mx",
    status: "accepted",
    accountName: "Tarjeta personal • 1234",
    amount: { amountMinor: 79900, currency: "MXN" },
    merchantRaw: "LIBRERÍA CENTRAL 017",
    categoryId: "shopping",
    occurredAt: "2026-07-11T20:10:00Z",
    receivedAt: "2026-07-11T20:13:00Z",
    ingestedAt: "2026-07-11T20:13:05Z",
    parserVersion: "amex-mx@0.1.0",
    source: source("2026/07/11/evt_01J59ZZ9.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "American Express <alerts@example.test>",
      "Compra aprobada",
      "Se registró una compra por $799.00 MXN en LIBRERÍA CENTRAL 017.\nTarjeta terminación 1234.",
    ),
    revisions: [],
  },
  {
    id: "evt_01J5GROC",
    institution: "nu_mx",
    status: "accepted",
    accountName: "Nu • 4421",
    amount: { amountMinor: 35600, currency: "MXN" },
    merchantRaw: "SUPERAMA POLANCO",
    categoryId: "supermercado",
    occurredAt: "2026-07-09T18:22:00Z",
    receivedAt: "2026-07-09T18:24:00Z",
    ingestedAt: "2026-07-09T18:24:08Z",
    parserVersion: "nu-mx@0.1.0",
    source: source("2026/07/09/evt_01J5GROC.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "Nu <alerts@example.test>",
      "Compra con tu tarjeta",
      "Compra de $356.00 MXN en SUPERAMA POLANCO.",
    ),
    revisions: [],
  },
  {
    id: "evt_01J5UBER",
    institution: "american_express_mx",
    status: "accepted",
    accountName: "Tarjeta personal • 1234",
    amount: { amountMinor: 18750, currency: "MXN" },
    merchantRaw: "UBER TRIP HELP.UBER.COM",
    categoryId: "transporte",
    tags: ["viaje:cdmx"],
    occurredAt: "2026-07-08T07:41:00Z",
    receivedAt: "2026-07-08T07:43:00Z",
    ingestedAt: "2026-07-08T07:43:11Z",
    parserVersion: "amex-mx@0.1.0",
    source: source("2026/07/08/evt_01J5UBER.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "American Express <alerts@example.test>",
      "Compra aprobada",
      "Se registró una compra por $187.50 MXN en UBER TRIP.",
    ),
    revisions: [],
  },
  {
    id: "evt_01J5GYM",
    institution: "santander_mx",
    status: "accepted",
    accountName: "Tarjeta viajes • 8192",
    amount: { amountMinor: 98000, currency: "MXN" },
    merchantRaw: "SPORT CITY REFORMA",
    categoryId: "deportes",
    occurredAt: "2026-07-05T16:05:00Z",
    receivedAt: "2026-07-05T16:07:00Z",
    ingestedAt: "2026-07-05T16:07:04Z",
    parserVersion: "santander-mx@0.1.0",
    source: source("2026/07/05/evt_01J5GYM.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "Santander Alertas <alerts@example.test>",
      "Aviso de compra",
      "Compra por $980.00 MXN en SPORT CITY REFORMA.",
    ),
    revisions: [],
  },
  {
    id: "evt_01J5AWS",
    institution: "american_express_mx",
    status: "accepted",
    accountName: "Tarjeta personal • 1234",
    amount: { amountMinor: 41200, currency: "MXN" },
    merchantRaw: "AWS EMEA",
    categoryId: "suscripciones",
    tags: ["trabajo"],
    occurredAt: "2026-07-03T11:12:00Z",
    receivedAt: "2026-07-03T11:14:00Z",
    ingestedAt: "2026-07-03T11:14:06Z",
    parserVersion: "amex-mx@0.1.0",
    source: source("2026/07/03/evt_01J5AWS.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "American Express <alerts@example.test>",
      "Compra aprobada",
      "Se registró una compra por $412.00 MXN en AWS EMEA.",
    ),
    revisions: [],
  },
  {
    id: "evt_01J5MSI1",
    institution: "american_express_mx",
    status: "accepted",
    accountName: "Tarjeta personal • 1007",
    amount: { amountMinor: 674900, currency: "MXN" },
    merchantRaw: "MESES EN AUTOMÁTICO NACIONAL",
    categoryId: "transferencias",
    occurredAt: "2026-06-06T12:00:00Z",
    receivedAt: "2026-06-06T12:05:00Z",
    ingestedAt: "2026-06-06T12:05:10Z",
    parserVersion: "amex-mx@0.1.0",
    source: source("2026/06/06/evt_01J5MSI1.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "American Express <alerts@example.test>",
      "Compra aprobada",
      "Se registró una compra por $6,749.00 MXN.\nTarjeta terminación 1007.",
    ),
    revisions: [],
    msi: buildMsiSchedule({
      principalMinor: 674900,
      months: 3,
      startMonth: "2026-06",
      origin: "amex_auto",
      cuotaMinor: 224967,
    }),
  },
  {
    id: "evt_01J5MSI2",
    institution: "santander_mx",
    status: "accepted",
    accountName: "Tarjeta viajes • 8192",
    amount: { amountMinor: 1198800, currency: "MXN" },
    merchantRaw: "APPLE STORE SANTA FE",
    categoryId: "shopping",
    occurredAt: "2026-05-18T19:30:00Z",
    receivedAt: "2026-05-18T19:32:00Z",
    ingestedAt: "2026-05-18T19:32:12Z",
    parserVersion: "santander-mx@0.1.0",
    source: source("2026/05/18/evt_01J5MSI2.eml"),
    parseWarnings: [],
    rawEmail: rawEmail(
      "Santander Alertas <alerts@example.test>",
      "Compra MSI",
      "Compra por $11,988.00 MXN en APPLE STORE SANTA FE a 6 meses.",
    ),
    revisions: [],
    msi: buildMsiSchedule({
      principalMinor: 1198800,
      months: 6,
      startMonth: "2026-05",
      origin: "manual",
      cuotaMinor: 199800,
    }),
  },
];

export const mockExceptions: readonly IngestionException[] = [
  {
    id: "exc_01J5FAIL1",
    receivedAt: "2026-07-11T22:18:00Z",
    institution: "santander_mx",
    reason: "parser_mismatch",
    details: "El asunto no coincide con ninguna plantilla conocida de alerta de compra.",
  },
];

const mockExceptionRaw: Record<string, string> = {
  exc_01J5FAIL1: rawEmail(
    "Santander Alertas <alerts@example.test>",
    "Notificación",
    "No pudimos clasificar este mensaje automáticamente.\nContenido de ejemplo para revisión local.",
  ),
};

/**
 * Mirrors GET /events?month=: events in the spend month, plus earlier MSI
 * purchases with a cuota in that month as `msiRelated`.
 */
export function mockFeedForMonth(month: string): EventFeed {
  const events = mockEvents.filter((event) => spendMonth(event) === month);
  const eventIds = new Set(events.map((event) => event.id));
  const msiRelated = mockEvents.filter((event) => {
    if (eventIds.has(event.id)) return false;
    return Boolean(event.msi?.installments.some((item) => item.month === month));
  });
  return { events, msiRelated };
}

/** Demo-only stand-in for the API's canonical month-summary endpoint. */
export function mockMonthSummaryFor(month: string, plan: MonthlyPlan, now: Date): MonthSummary {
  const feed = mockFeedForMonth(month);
  return computeMonthSummary({
    events: [...feed.events, ...feed.msiRelated].map((event) => ({
      id: event.id,
      amountMinor: event.amount.amountMinor,
      personalAmountMinor: event.personalAmountMinor,
      status: event.status,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      merchantRaw: event.merchantRaw,
      msi: event.msi,
    })),
    month,
    incomeMinor: plan.incomeMinor,
    incomeConfigured: plan.configured,
    upcomingPaymentsMinor: plan.upcomingPayments.reduce((sum, payment) => sum + payment.amountMinor, 0),
    now,
  });
}

const mockCategorizedEvents = (): CategorizedSpendEvent[] => mockEvents.map((event) => ({
  id: event.id,
  amountMinor: event.amount.amountMinor,
  personalAmountMinor: event.personalAmountMinor,
  status: event.status,
  occurredAt: event.occurredAt,
  receivedAt: event.receivedAt,
  merchantRaw: event.merchantRaw,
  categoryId: event.categoryId,
  tags: event.tags,
  msi: event.msi,
}));

/** Demo-only stand-in for GET /analytics. */
export function mockAnalyticsFor(month: string, now: Date): SpendingAnalytics {
  const againstMonth = previousCalendarMonth(month) ?? month;
  const events = mockCategorizedEvents();
  const names = new Map(DEFAULT_SPEND_CATEGORIES.map((category) => [category.id, category.name]));
  const current = aggregateSpendByCategory(events, month, names);
  const throughDay = month === monthKeyInZone(now)
    ? Math.min(dayInZone(now), daysInCalendarMonth(againstMonth))
    : undefined;
  const against = aggregateSpendByCategory(
    events,
    againstMonth,
    names,
    throughDay === undefined ? undefined : { throughDay },
  );
  const tags = aggregateSpendByTag(events, month);
  const merchants = aggregateSpendByMerchant(events, month, { limit: 10 });
  const excludedMonthOnlyMinor = throughDay === undefined
    ? 0
    : events.reduce((sum, event) => sum + monthOnlySpendAmountForMonth(event, againstMonth), 0);
  return {
    month,
    comparison: {
      againstMonth,
      ...(throughDay === undefined ? {} : { throughDay }),
      amountMinor: current.totalSpentMinor,
      againstAmountMinor: against.totalSpentMinor,
      deltaMinor: current.totalSpentMinor - against.totalSpentMinor,
      excludedMonthOnlyMinor,
    },
    categories: compareSpendBuckets(current.buckets, against.buckets),
    tags: tags.buckets,
    merchants: merchants.buckets,
    confidence: {
      uncategorizedMinor: current.uncategorizedMinor,
      uncategorizedEventCount: current.uncategorizedEventCount,
      uncertainMinor: current.uncertainMinor,
      uncertainEventIds: events
        .filter((event) => uncertainAmountForMonth(event, month) > 0)
        .map((event) => event.id),
    },
  };
}

/** @deprecated Prefer `mockFeedForMonth`; kept for callers that need the full July-shaped feed. */
export const mockEventFeed: EventFeed = mockFeedForMonth("2026-07");

export function mockExceptionRawEmail(exceptionId: string): string {
  return (
    mockExceptionRaw[exceptionId] ??
    rawEmail("demo@example.test", "Correo de ejemplo", "Fuente mock no encontrada.")
  );
}

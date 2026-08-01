import type { EventFeed } from "../types";

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

export const mockEventFeed: EventFeed = {
  events: [
    {
      id: "evt_01J5A0A1",
      institution: "american_express_mx",
      status: "accepted",
      accountName: "Tarjeta personal • 1234",
      amount: { amountMinor: 48500, currency: "MXN" },
      merchantRaw: "CAFÉ DEL PARQUE CDMX",
      occurredAt: "2026-07-12T13:38:00Z",
      receivedAt: "2026-07-12T13:42:00Z",
      ingestedAt: "2026-07-12T13:42:09Z",
      parserVersion: "amex-mx@0.1.0",
      source: source("2026/07/12/evt_01J5A0A1.eml"),
      parseWarnings: [],
      rawEmail: rawEmail("American Express <alerts@example.test>", "Compra aprobada", "Se registró una compra por $485.00 MXN en CAFÉ DEL PARQUE CDMX.\nTarjeta terminación 1234."),
      revisions: [],
    },
    {
      id: "evt_01J5A0A2",
      institution: "santander_mx",
      status: "needs_review",
      accountName: "Tarjeta viajes • 8192",
      amount: { amountMinor: 124900, currency: "MXN" },
      merchantRaw: "RESERVA SERVICIOS ONLINE",
      occurredAt: "2026-07-12T09:15:00Z",
      receivedAt: "2026-07-12T09:17:00Z",
      ingestedAt: "2026-07-12T09:17:14Z",
      parserVersion: "santander-mx@0.1.0",
      source: source("2026/07/12/evt_01J5A0A2.eml"),
      parseWarnings: ["El comercio se extrajo, pero el formato de hora no coincide con la plantilla conocida."],
      rawEmail: rawEmail("Santander Alertas <alerts@example.test>", "Aviso de compra", "Detectamos una compra por $1,249.00 MXN.\nComercio: RESERVA SERVICIOS ONLINE\nTarjeta terminación 8192."),
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
      occurredAt: "2026-07-11T20:10:00Z",
      receivedAt: "2026-07-11T20:13:00Z",
      ingestedAt: "2026-07-11T20:13:05Z",
      parserVersion: "amex-mx@0.1.0",
      source: source("2026/07/11/evt_01J59ZZ9.eml"),
      parseWarnings: [],
      rawEmail: rawEmail("American Express <alerts@example.test>", "Compra aprobada", "Se registró una compra por $799.00 MXN en LIBRERÍA CENTRAL 017.\nTarjeta terminación 1234."),
      revisions: [],
    },
  ],
};

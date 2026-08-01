import { describe, expect, it } from "vitest";
import {
  AmexMxCardPurchaseParser,
  InMemoryLedgerRepository,
  InMemoryNotifier,
  InMemoryRawSourceStore,
  IngestionPipeline,
  SantanderMxCardPurchaseParser,
} from "../src/index.js";

const ids = (...values: string[]) => ({ next: () => values.shift() ?? "unexpected-id" });
const fixedClock = { now: () => new Date("2026-08-01T18:00:00.000Z") };

const createPipeline = () => {
  const rawSources = new InMemoryRawSourceStore();
  const ledger = new InMemoryLedgerRepository();
  const notifier = new InMemoryNotifier();
  return {
    rawSources,
    ledger,
    notifier,
    pipeline: new IngestionPipeline({
      rawSources,
      ledger,
      notifier,
      parsers: [new AmexMxCardPurchaseParser(), new SantanderMxCardPurchaseParser()],
      clock: fixedClock,
      ids: ids("purchase-1", "exception-1"),
    }),
  };
};

const amexEmail = `From: alertas@americanexpress.com.mx\nMessage-ID: <amex-1@example.com>\n\nAmerican Express\nImporte de $347.00 MXN\nEstablecimiento: UBER *TRIP\nTarjeta terminación 1234\nFecha: 2026-08-01T17:55:00Z`;
const santanderEmail = `From: alertas@santander.com.mx\nMessage-ID: <santander-1@example.com>\n\nSantander\nCompra por $1,250.50 MXN\nEn: CAFETERIA ROMA\nTarjeta **** 5678\nFecha: 2026-08-01T17:55:00Z`;
const santanderUniqueRewardsEmail = `From: Santander <santander@envio.santander.com.mx>\nMessage-ID: <santander-unique-1@example.com>\n\nSantander Unique Rewards\nRealizaste una compra con tu Tarjeta crédito terminación 6349\nTe informamos que se autorizó una compra en LIBRERIA DEL CENTRO por un monto de $52.36 M.N.`;

describe("IngestionPipeline", () => {
  it("persists, parses and notifies a valid Amex purchase", async () => {
    const { pipeline, ledger, rawSources, notifier } = createPipeline();

    const result = await pipeline.ingest({
      mime: amexEmail,
      sourceMessageId: "<amex-1@example.com>",
      receivedAt: "2026-08-01T17:56:00.000Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      id: "purchase-1",
      institution: "american_express_mx",
      status: "accepted",
      merchantRaw: "UBER *TRIP",
      amount: { amountMinor: 34700, currency: "MXN" },
      account: { lastFour: "1234" },
    });
    expect(await rawSources.get(result.purchase.source)).toBe(amexEmail);
    expect(ledger.purchases.size).toBe(1);
    expect(notifier.observedPurchases).toHaveLength(1);
  });

  it("keeps the source and creates a review exception when a parser fails", async () => {
    const { pipeline, ledger, rawSources, notifier } = createPipeline();
    const malformed = `From: alertas@santander.com.mx\n\nSantander\nCompra por $99.99 MXN`;

    const result = await pipeline.ingest({ mime: malformed, receivedAt: "2026-08-01T17:56:00.000Z" });

    expect(result.kind).toBe("needs_review");
    if (result.kind !== "needs_review") return;
    expect(result.exception.reason).toBe("parser_failed");
    expect(await rawSources.get(result.exception.source)).toBe(malformed);
    expect(ledger.purchases.size).toBe(0);
    expect(ledger.exceptions.size).toBe(1);
    expect(notifier.reportedExceptions).toHaveLength(1);
  });

  it("parses a valid Santander purchase deterministically", async () => {
    const { pipeline } = createPipeline();

    const result = await pipeline.ingest({
      mime: santanderEmail,
      sourceMessageId: "<santander-1@example.com>",
      receivedAt: "2026-08-01T17:56:00.000Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      institution: "santander_mx",
      merchantRaw: "CAFETERIA ROMA",
      amount: { amountMinor: 125050, currency: "MXN" },
      account: { lastFour: "5678" },
    });
  });

  it("prioritizes the Santander Unique Rewards purchase wording", async () => {
    const { pipeline } = createPipeline();

    const result = await pipeline.ingest({
      mime: santanderUniqueRewardsEmail,
      sourceMessageId: "<santander-unique-1@example.com>",
      receivedAt: "2026-08-01T17:56:00.000Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      institution: "santander_mx",
      merchantRaw: "LIBRERIA DEL CENTRO",
      amount: { amountMinor: 5236, currency: "MXN" },
      account: { lastFour: "6349" },
    });
  });

  it("does not create or notify a duplicate email", async () => {
    const { pipeline, ledger, notifier } = createPipeline();
    const email = { mime: amexEmail, sourceMessageId: "<amex-1@example.com>", receivedAt: "2026-08-01T17:56:00.000Z" };

    await pipeline.ingest(email);
    const duplicate = await pipeline.ingest(email);

    expect(duplicate.kind).toBe("duplicate");
    expect(ledger.purchases.size).toBe(1);
    expect(notifier.observedPurchases).toHaveLength(1);
  });
});

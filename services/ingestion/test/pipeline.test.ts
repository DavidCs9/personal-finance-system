import { describe, expect, it } from "vitest";
import {
  AmexMxCardPurchaseParser,
  AwsMxBillingStatementParser,
  InMemoryLedgerRepository,
  InMemoryNotifier,
  InMemoryRawSourceStore,
  IngestionPipeline,
  NuMxOutgoingTransferParser,
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
const santanderUniqueRewardsEmail = `From: Santander <santander@envio.santander.com.mx>\nMessage-ID: <santander-unique-1@example.com>\n\nSantander Unique Rewards\nHola, Estimado Cliente. 31/07/2026.\nRealizaste una compra con tu Tarjeta crédito terminación 6349\nTe informamos que se autorizó una compra en LIBRERIA DEL CENTRO por un monto de $52.36 M.N.`;
const santanderQuotedPrintableHtmlEmail = `From: owner@example.com\r
Subject: Fw: Tu compra Santander\r
Message-ID: <santander-html-1@example.com>\r
Content-Transfer-Encoding: quoted-printable\r
Content-Type: text/html; charset=utf-8\r
\r
<html><body><div>Santander Unique Rewards</div>
<div>Hola, Estimado Cliente. 31/07/2026.</div>
<div>Realizaste una compra con tu Tarjeta cr=C3=A9dito terminaci=C3=B3n 6349</div>
<div>Te informamos que se autoriz=C3=B3 una compra en LIBRERIA DEL CEN=\r
TRO por un monto de $52.36 M.N.</div></body></html>`;
const nuTransferEmail = `From: Nu <nu@nu.com.mx>\nSubject: Tu transferencia fue exitosa\nMessage-ID: <nu-transfer-1@example.com>\n\nTransferencia exitosa\nDetalles de la transferencia:\nMonto: $2,139.00\nFecha: 31/JUL/2026\nHora: 09:47\nTipo de transferencia: SPEI\nConcepto: Transferencia\nNúmero de referencia: 310726\nFolio: QUD7JAXQ4\nNombre: Moneypool\nEntidad: STP\nCLABE: ••••7067\nEstatus: Completada\nClave de rastreo: NU3ADJ1PN3U499UASNLP4FJDQBU9`;
const nuQuotedPrintableHtmlEmail = `From: Nu <nu@nu.com.mx>\r
To: owner@example.com\r
Subject: Tu transferencia fue exitosa\r
Message-ID: <nu-transfer-html-1@example.com>\r
Content-Transfer-Encoding: quoted-printable\r
Content-Type: text/html; charset=utf-8\r
\r
<html><body><div>Te confirmamos que tu transferencia fue realizada</div>
<div>Detalles de la transferencia:</div>
<div>Monto: $0.01<br>Fecha: 01/AGO/2026<br>Hora: 16:06<br>Tipo de transferencia: SPEI<br>Concepto: prueba<br>N=C3=BAmero de referencia: 10826<br>Folio: QUFAS5PYN<br>Nombre: PERSONA DESTINATA=\r
RIA<br>Entidad: SANTANDER<br>CLABE: =E2=80=A2=E2=80=A2=E2=80=A2=E2=80=A23649<br>Estatus: Completada<br>Clave de rastreo: NU3TESTTRACKINGKEY</div></body></html>`;
const awsBillingHtmlEmail = `From: Amazon Web Services <invoicing@aws.com>\r
Subject: Amazon Web Services Billing Statement Available [Account: 225989371926]\r
Message-ID: <aws-billing-2026-07@example.com>\r
Content-Transfer-Encoding: quoted-printable\r
Content-Type: text/html; charset=utf-8\r
\r
<html><body><p>Greetings from Amazon Web Services,</p>
<p>This e-mail confirms that your latest billing statement, for the account ending in ****1926, is available. Your account will be charged the following:<br>Total in MXN: $55.84*</p>
<p>The credit card ending in 6349 is currently your default payment method for your AWS charges.</p>
<a href=3D"https://console.aws.amazon.com/billing/home#/bills?year=3D2026&amp;month=3D7">Billing &amp; Cost Management</a>
</body></html>`;

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
      occurredAt: "2026-07-31T12:00:00.000Z",
    });
  });

  it("decodes a forwarded Santander quoted-printable HTML purchase", async () => {
    const rawSources = new InMemoryRawSourceStore();
    const ledger = new InMemoryLedgerRepository();
    const notifier = new InMemoryNotifier();
    const pipeline = new IngestionPipeline({
      rawSources,
      ledger,
      notifier,
      parsers: [new SantanderMxCardPurchaseParser()],
      clock: fixedClock,
      ids: ids("santander-html-1"),
    });

    const result = await pipeline.ingest({
      mime: santanderQuotedPrintableHtmlEmail,
      sourceMessageId: "<santander-html-1@example.com>",
      receivedAt: "2026-08-01T17:56:00.000Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      institution: "santander_mx",
      eventType: "card_purchase",
      merchantRaw: "LIBRERIA DEL CENTRO",
      amount: { amountMinor: 5236, currency: "MXN" },
      account: { lastFour: "6349" },
      occurredAt: "2026-07-31T12:00:00.000Z",
      parserVersion: "santander-mx-card-purchase-v2",
    });
  });

  it("captures a completed outgoing Nu SPEI transfer", async () => {
    const rawSources = new InMemoryRawSourceStore();
    const ledger = new InMemoryLedgerRepository();
    const notifier = new InMemoryNotifier();
    const pipeline = new IngestionPipeline({
      rawSources,
      ledger,
      notifier,
      parsers: [new NuMxOutgoingTransferParser()],
      clock: fixedClock,
      ids: ids("nu-transfer-1"),
    });

    const result = await pipeline.ingest({
      mime: nuTransferEmail,
      sourceMessageId: "<nu-transfer-1@example.com>",
      receivedAt: "2026-08-01T15:51:00.000Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      institution: "nu_mx",
      eventType: "outgoing_transfer",
      account: { accountId: "nu_mx:primary", displayName: "Cuenta Nu" },
      merchantRaw: "Moneypool",
      counterparty: "Moneypool",
      amount: { amountMinor: 213900, currency: "MXN" },
      transferType: "spei",
      reference: "310726",
      folio: "QUD7JAXQ4",
      trackingKey: "NU3ADJ1PN3U499UASNLP4FJDQBU9",
      counterpartyInstitution: "STP",
      counterpartyAccountLastFour: "7067",
      occurredAt: "2026-07-31T15:47:00.000Z",
    });
  });

  it("decodes Nu's quoted-printable HTML without matching the Santander destination", async () => {
    const rawSources = new InMemoryRawSourceStore();
    const ledger = new InMemoryLedgerRepository();
    const notifier = new InMemoryNotifier();
    const pipeline = new IngestionPipeline({
      rawSources,
      ledger,
      notifier,
      parsers: [new SantanderMxCardPurchaseParser(), new NuMxOutgoingTransferParser()],
      clock: fixedClock,
      ids: ids("nu-transfer-html-1"),
    });

    const result = await pipeline.ingest({
      mime: nuQuotedPrintableHtmlEmail,
      sourceMessageId: "<nu-transfer-html-1@example.com>",
      receivedAt: "2026-08-01T22:07:01.094Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      institution: "nu_mx",
      eventType: "outgoing_transfer",
      amount: { amountMinor: 1, currency: "MXN" },
      merchantRaw: "PERSONA DESTINATARIA",
      counterpartyInstitution: "SANTANDER",
      counterpartyAccountLastFour: "3649",
      reference: "10826",
      folio: "QUFAS5PYN",
      trackingKey: "NU3TESTTRACKINGKEY",
      occurredAt: "2026-08-01T22:06:00.000Z",
      parserVersion: "nu-mx-outgoing-transfer-v2",
    });
  });

  it("captures an AWS MXN billing statement as a card charge", async () => {
    const rawSources = new InMemoryRawSourceStore();
    const ledger = new InMemoryLedgerRepository();
    const notifier = new InMemoryNotifier();
    const pipeline = new IngestionPipeline({
      rawSources,
      ledger,
      notifier,
      parsers: [new AwsMxBillingStatementParser()],
      clock: fixedClock,
      ids: ids("aws-charge-1"),
    });

    const result = await pipeline.ingest({
      mime: awsBillingHtmlEmail,
      sourceMessageId: "<aws-billing-2026-07@example.com>",
      receivedAt: "2026-08-01T22:30:00.000Z",
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.purchase).toMatchObject({
      institution: "amazon_web_services",
      eventType: "card_charge",
      merchantRaw: "Amazon Web Services",
      amount: { amountMinor: 5584, currency: "MXN" },
      account: { accountId: "amazon_web_services:1926", lastFour: "1926" },
      billingPeriod: "2026-07",
      paymentMethodLastFour: "6349",
      receivedAt: "2026-08-01T22:30:00.000Z",
      parserVersion: "aws-mx-billing-statement-v1",
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

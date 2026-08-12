import { describe, expect, it } from "vitest";
import { emailParsers, shouldIgnoreEmail } from "../src/parsers.js";

const parser = (institution: string) => {
  const match = emailParsers.find((candidate) => candidate.institution === institution);
  if (!match) throw new Error(`Missing parser for ${institution}`);
  return match;
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
const nuTransferWithoutTypeEmail = `From: Nu <nu@nu.com.mx>\nSubject: Tu transferencia fue exitosa\nMessage-ID: <nu-transfer-no-type-1@example.com>\n\nTransferencia exitosa\nDetalles de la transferencia:\nMonto: $2,139.00\nFecha: 31/JUL/2026\nHora: 09:47\nNúmero de referencia: 310726\nFolio: QUD7JAXQ4\nNombre: Moneypool\nEntidad: STP\nCLABE: ••••7067\nEstatus: Completada\nClave de rastreo: NU3ADJ1PN3U499UASNLP4FJDQBU9`;
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
const forwardedSantanderPurchase = `From: David Castro <david@example.com>\r
To: alertas@inbound.finance.example.com\r
Subject: Fw: Tu compra te acaba de generar Unique Points\r
Content-Type: multipart/alternative; boundary="forwarded-message"\r
\r
--forwarded-message\r
Content-Type: text/plain; charset="Windows-1252"\r
Content-Transfer-Encoding: quoted-printable\r
\r
-----Mensaje reenviado-----\r
From: Santander <santander@envio.santander.com.mx>\r
Subject: Tu compra te acaba de generar Unique Points\r
\r
Realizaste una compra con tu Tarjeta cr=E9dito terminaci=F3n 6349\r
Te informamos que se autoriz=F3 una compra en ZARA CHIHUAHUA por un monto de $115.00 M.N.\r
--forwarded-message\r
Content-Type: text/html; charset="Windows-1252"\r
Content-Transfer-Encoding: quoted-printable\r
\r
<html><body><p>From: Santander &lt;santander@envio.santander.com.mx&gt;</p><p>Te informamos que se autoriz=F3 una compra en ZARA CHIHUAHUA por un monto de $115.00 M.N.</p></body></html>\r
--forwarded-message--\r
`;

describe("emailParsers", () => {
  it("ignores Gmail forwarding confirmation messages", () => {
    expect(shouldIgnoreEmail("From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: Gmail Forwarding Confirmation - Receive Mail\r\n\r\nConfirmation instructions")).toBe(true);
  });

  it("parses a valid Amex purchase", () => {
    const amex = parser("american_express_mx");
    expect(amex.matches(amexEmail)).toBe(true);
    expect(amex.parse(amexEmail)).toMatchObject({
      institution: "american_express_mx",
      merchantRaw: "UBER *TRIP",
      amount: { amountMinor: 34700, currency: "MXN" },
      account: { lastFour: "1234" },
    });
  });

  it("parses a valid Santander purchase", () => {
    expect(parser("santander_mx").parse(santanderEmail)).toMatchObject({
      institution: "santander_mx",
      merchantRaw: "CAFETERIA ROMA",
      amount: { amountMinor: 125050, currency: "MXN" },
      account: { lastFour: "5678" },
    });
  });

  it("prioritizes the Santander Unique Rewards purchase wording", () => {
    expect(parser("santander_mx").parse(santanderUniqueRewardsEmail)).toMatchObject({
      institution: "santander_mx",
      merchantRaw: "LIBRERIA DEL CENTRO",
      amount: { amountMinor: 5236, currency: "MXN" },
      account: { lastFour: "6349" },
      occurredAt: "2026-07-31T12:00:00.000Z",
    });
  });

  it("decodes a forwarded Santander quoted-printable HTML purchase", () => {
    const santander = parser("santander_mx");
    expect(santander.parse(santanderQuotedPrintableHtmlEmail)).toMatchObject({
      institution: "santander_mx",
      merchantRaw: "LIBRERIA DEL CENTRO",
      amount: { amountMinor: 5236, currency: "MXN" },
      account: { lastFour: "6349" },
      occurredAt: "2026-07-31T12:00:00.000Z",
    });
    expect(santander.version).toBe("santander-mx-card-purchase-v3");
  });

  it("parses a quoted-printable Windows-1252 Santander alert forwarded through a multipart email", () => {
    const santander = parser("santander_mx");
    expect(santander.matches(forwardedSantanderPurchase)).toBe(true);
    expect(santander.parse(forwardedSantanderPurchase)).toMatchObject({
      institution: "santander_mx",
      merchantRaw: "ZARA CHIHUAHUA",
      account: { lastFour: "6349" },
      amount: { amountMinor: 11500, currency: "MXN" },
    });
  });

  it("fails when Santander amount/merchant are missing", () => {
    expect(() => parser("santander_mx").parse("From: alertas@santander.com.mx\n\nSantander\nCompra por $99.99 MXN")).toThrow(/missing amount or merchant/i);
  });

  it("captures a completed outgoing Nu SPEI transfer", () => {
    expect(parser("nu_mx").parse(nuTransferEmail)).toMatchObject({
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

  it("captures a completed Nu transfer when the alert omits its transfer-type row", () => {
    expect(parser("nu_mx").parse(nuTransferWithoutTypeEmail)).toMatchObject({
      institution: "nu_mx",
      eventType: "outgoing_transfer",
      merchantRaw: "Moneypool",
      amount: { amountMinor: 213900, currency: "MXN" },
      transferType: "spei",
      occurredAt: "2026-07-31T15:47:00.000Z",
    });
  });

  it("preserves a late-night Nu transfer's local calendar date when converting to UTC", () => {
    const lateTransfer = nuTransferWithoutTypeEmail
      .replace("31/JUL/2026", "10/AGO/2026")
      .replace("09:47", "23:47");
    expect(parser("nu_mx").parse(lateTransfer)).toMatchObject({
      institution: "nu_mx",
      occurredAt: "2026-08-11T05:47:00.000Z",
    });
  });

  it("decodes Nu quoted-printable HTML without matching Santander destination as merchant", () => {
    const nu = parser("nu_mx");
    expect(nu.matches(nuQuotedPrintableHtmlEmail)).toBe(true);
    expect(nu.parse(nuQuotedPrintableHtmlEmail)).toMatchObject({
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
    });
    expect(nu.version).toBe("nu-mx-outgoing-transfer-v5");
  });

  it("captures an AWS MXN billing statement as a card charge", () => {
    const aws = parser("amazon_web_services");
    expect(aws.matches(awsBillingHtmlEmail)).toBe(true);
    expect(aws.parse(awsBillingHtmlEmail)).toMatchObject({
      institution: "amazon_web_services",
      eventType: "card_charge",
      merchantRaw: "Amazon Web Services",
      amount: { amountMinor: 5584, currency: "MXN" },
      account: { accountId: "amazon_web_services:1926", lastFour: "1926" },
      billingPeriod: "2026-07",
      paymentMethodLastFour: "6349",
    });
    expect(aws.version).toBe("aws-mx-billing-statement-v1");
  });
});

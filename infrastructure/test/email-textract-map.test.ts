import { describe, expect, it } from 'vitest';
import {
  detectEmailInstitution,
  documentTextForTextract,
  mapTextractEmailPurchase,
  shouldIgnoreEmail,
} from '@finance/ingestion';
import { normalizeEmailTextractAnalysis, renderEmailBodyPdf } from '../lambda/email-textract.js';

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

describe('email Textract mapping', () => {
  it('ignores Gmail forwarding confirmation messages', () => {
    expect(shouldIgnoreEmail('From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: Gmail Forwarding Confirmation - Receive Mail\r\n\r\nConfirmation instructions')).toBe(true);
  });

  it('routes a forwarded Santander Unique Points alert without reading amount fields', () => {
    expect(detectEmailInstitution(forwardedSantanderPurchase)).toBe('santander_mx');
    expect(documentTextForTextract(forwardedSantanderPurchase)).toContain('ZARA CHIHUAHUA');
    expect(documentTextForTextract(forwardedSantanderPurchase)).toContain('115.00');
  });

  it('keeps AWS billing URLs in the Textract document text', () => {
    expect(detectEmailInstitution(awsBillingHtmlEmail)).toBe('amazon_web_services');
    expect(documentTextForTextract(awsBillingHtmlEmail)).toContain('year=2026');
    expect(documentTextForTextract(awsBillingHtmlEmail)).toContain('month=7');
  });

  it('renders a PDF that starts with the PDF header', () => {
    const pdf = renderEmailBodyPdf('American Express\nImporte de $347.00 MXN\nEstablecimiento: UBER *TRIP');
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('maps Amex query answers to a purchase', () => {
    const purchase = mapTextractEmailPurchase('american_express_mx', {
      answers: {
        AMOUNT: '$347.00 MXN',
        MERCHANT: 'UBER *TRIP',
        ACCOUNT_LAST_FOUR: '1234',
        OCCURRED_AT: '2026-08-01T17:55:00Z',
      },
    });
    expect(purchase).toMatchObject({
      institution: 'american_express_mx',
      merchantRaw: 'UBER *TRIP',
      amount: { amountMinor: 34700, currency: 'MXN' },
      account: { lastFour: '1234' },
      occurredAt: '2026-08-01T17:55:00.000Z',
      parserVersion: 'amex-mx-card-purchase-textract-v1',
    });
  });

  it('maps Santander Unique Rewards answers', () => {
    const purchase = mapTextractEmailPurchase('santander_mx', {
      answers: {
        AMOUNT: '$115.00 M.N.',
        MERCHANT: 'ZARA CHIHUAHUA',
        ACCOUNT_LAST_FOUR: 'terminación 6349',
        OCCURRED_AT: '31/07/2026',
      },
    });
    expect(purchase).toMatchObject({
      institution: 'santander_mx',
      merchantRaw: 'ZARA CHIHUAHUA',
      amount: { amountMinor: 11500, currency: 'MXN' },
      account: { lastFour: '6349' },
      occurredAt: '2026-07-31T12:00:00.000Z',
      parserVersion: 'santander-mx-card-purchase-textract-v1',
    });
  });

  it('maps Nu SPEI answers', () => {
    const purchase = mapTextractEmailPurchase('nu_mx', {
      answers: {
        AMOUNT: '$2,139.00',
        RECIPIENT: 'Moneypool',
        DATE: '31/JUL/2026',
        TIME: '09:47',
        TRANSFER_TYPE: 'SPEI',
        STATUS: 'Completada',
        REFERENCE: '310726',
        FOLIO: 'QUD7JAXQ4',
        TRACKING_KEY: 'NU3ADJ1PN3U499UASNLP4FJDQBU9',
        COUNTERPARTY_INSTITUTION: 'STP',
        CLABE_LAST_FOUR: '7067',
      },
    });
    expect(purchase).toMatchObject({
      institution: 'nu_mx',
      eventType: 'outgoing_transfer',
      merchantRaw: 'Moneypool',
      amount: { amountMinor: 213900, currency: 'MXN' },
      counterpartyAccountLastFour: '7067',
      occurredAt: '2026-07-31T15:47:00.000Z',
      parserVersion: 'nu-mx-outgoing-transfer-textract-v1',
    });
  });

  it('maps AWS billing answers including period', () => {
    const purchase = mapTextractEmailPurchase('amazon_web_services', {
      answers: {
        AMOUNT_MXN: '$55.84',
        AWS_ACCOUNT_LAST_FOUR: '1926',
        PAYMENT_CARD_LAST_FOUR: '6349',
        BILLING_YEAR: '2026',
        BILLING_MONTH: '7',
      },
    });
    expect(purchase).toMatchObject({
      institution: 'amazon_web_services',
      eventType: 'card_charge',
      amount: { amountMinor: 5584, currency: 'MXN' },
      billingPeriod: '2026-07',
      paymentMethodLastFour: '6349',
      parserVersion: 'aws-mx-billing-statement-textract-v1',
    });
  });

  it('normalizes QUERY blocks into alias answers', () => {
    const extraction = normalizeEmailTextractAnalysis('santander_mx', [
      {
        Id: 'q1',
        BlockType: 'QUERY',
        Query: { Alias: 'AMOUNT', Text: 'What is the amount?' },
        Relationships: [{ Type: 'ANSWER', Ids: ['a1'] }],
      },
      {
        Id: 'a1',
        BlockType: 'QUERY_RESULT',
        Text: '$115.00 M.N.',
        Confidence: 99,
      },
      {
        Id: 'q2',
        BlockType: 'QUERY',
        Query: { Alias: 'MERCHANT', Text: 'What is the merchant?' },
        Relationships: [{ Type: 'ANSWER', Ids: ['a2'] }],
      },
      {
        Id: 'a2',
        BlockType: 'QUERY_RESULT',
        Text: 'ZARA CHIHUAHUA',
      },
    ]);
    expect(extraction.answers).toEqual({
      AMOUNT: '$115.00 M.N.',
      MERCHANT: 'ZARA CHIHUAHUA',
    });
  });
});

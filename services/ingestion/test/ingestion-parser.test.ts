import { describe, expect, it } from 'vitest';

process.env.METADATA_TABLE_NAME = 'test-metadata-table';
const { emailParsers, shouldIgnoreEmail } = await import('../src/process-email.js');

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

describe('email parsers', () => {
  it('ignores Gmail forwarding confirmation messages', () => {
    expect(shouldIgnoreEmail('From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: Gmail Forwarding Confirmation - Receive Mail\r\n\r\nConfirmation instructions')).toBe(true);
  });

  it('parses a quoted-printable Windows-1252 Santander alert forwarded through a multipart email', () => {
    const parser = emailParsers.find((candidate) => candidate.institution === 'santander_mx');
    expect(parser).toBeDefined();
    expect(parser?.matches(forwardedSantanderPurchase)).toBe(true);
    expect(parser?.parse(forwardedSantanderPurchase)).toMatchObject({
      institution: 'santander_mx',
      merchantRaw: 'ZARA CHIHUAHUA',
      account: { lastFour: '6349' },
      amount: { amountMinor: 11500, currency: 'MXN' },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseBedrockEmailExtraction, toParsedPurchase, type BedrockEmailExtraction } from '../src/bedrock-extractor.js';

const emailText = `Tu transferencia fue exitosa
Monto transferido: $2,139.00 MXN
Fecha y hora local: 12/08/2026 14:50
Beneficiario: Moneypool
Estado de operación: Completada
Rastreo SPEI: NU3TEST`;

const validNuExtraction: BedrockEmailExtraction = {
  recognized: true,
  institution: 'nu_mx',
  eventType: 'outgoing_transfer',
  completed: true,
  amountMinor: 213900,
  currency: 'MXN',
  merchantRaw: 'Moneypool',
  accountLastFour: null,
  counterparty: 'Moneypool',
  transferType: 'spei',
  reference: null,
  folio: null,
  trackingKey: 'NU3TEST',
  counterpartyInstitution: null,
  counterpartyAccountLastFour: null,
  billingPeriod: null,
  paymentMethodLastFour: null,
  occurredAt: '2026-08-12T14:50:00-06:00',
  rejectionReason: null,
  evidence: {
    amount: 'Monto transferido: $2,139.00 MXN',
    merchantOrCounterparty: 'Beneficiario: Moneypool',
    status: 'Estado de operación: Completada',
    occurredDate: 'Fecha y hora local: 12/08/2026',
    occurredTime: '14:50',
    account: null,
  },
};

describe('Bedrock email extraction validation', () => {
  it('accepts a template-independent Nu extraction backed by source evidence', () => {
    expect(toParsedPurchase(validNuExtraction, 'nu_mx', emailText)).toMatchObject({
      institution: 'nu_mx',
      eventType: 'outgoing_transfer',
      amount: { amountMinor: 213900, currency: 'MXN' },
      merchantRaw: 'Moneypool',
      counterparty: 'Moneypool',
      transferType: 'spei',
      occurredAt: '2026-08-12T20:50:00.000Z',
    });
  });

  it('rejects a semantically incorrect amount even when the response shape is valid', () => {
    expect(() => toParsedPurchase({ ...validNuExtraction, amountMinor: 99900 }, 'nu_mx', emailText))
      .toThrow(/amount did not match/i);
  });

  it('rejects evidence invented by the model', () => {
    const extraction = {
      ...validNuExtraction,
      evidence: { ...validNuExtraction.evidence, merchantOrCounterparty: 'Beneficiario: Inventado' },
    };
    expect(() => toParsedPurchase(extraction, 'nu_mx', emailText)).toThrow(/evidence was not found verbatim/i);
  });

  it('rejects a different institution than the trusted classifier selected', () => {
    const extraction = { ...validNuExtraction, institution: 'santander_mx' as const };
    expect(() => toParsedPurchase(extraction, 'nu_mx', emailText)).toThrow(/institution did not match/i);
  });

  it('runtime-validates structured output after JSON parsing', () => {
    expect(() => parseBedrockEmailExtraction(JSON.stringify({ ...validNuExtraction, amountMinor: -1 })))
      .toThrow(/non-negative safe integer/i);
  });
});

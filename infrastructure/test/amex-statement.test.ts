import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAmexStatementExtraction } from '../lambda/amex-statement.js';
import type { TextractStatementExtraction } from '../lambda/textract-document.js';

const gold = JSON.parse(
  readFileSync(new URL('./fixtures/amex-gold-extraction.json', import.meta.url), 'utf8'),
) as TextractStatementExtraction;
const aeromexico = JSON.parse(
  readFileSync(new URL('./fixtures/amex-aeromexico-extraction.json', import.meta.url), 'utf8'),
) as TextractStatementExtraction;

describe('parseAmexStatementExtraction', () => {
  it('maps Amex Gold MSI table charges and plan summary', () => {
    const document = parseAmexStatementExtraction(gold);
    expect(document.accountLastFour).toBe('1007');
    expect(document.period).toEqual({ from: '2026-06-07', to: '2026-07-06' });
    const msi = document.charges.filter((charge) => charge.msi);
    expect(msi.length).toBeGreaterThanOrEqual(2);
    expect(msi.some((charge) => charge.installmentIndex === 3 && charge.installmentMonths === 3 && charge.amountMinor === 82_532)).toBe(true);
    expect(msi.some((charge) => charge.installmentIndex === 2 && charge.amountMinor === 224_967)).toBe(true);
    expect(document.charges.some((charge) => /MANGO/i.test(charge.merchantRaw) && charge.amountMinor === 302_600 && !charge.msi)).toBe(true);
    expect(document.msiPlans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        merchantRaw: 'MESES EN AUTOMÁTICO NACIONAL',
        originalAmountMinor: 247_600,
        installmentIndex: 3,
        installmentMonths: 3,
        cuotaMinor: 82_532,
      }),
      expect.objectContaining({
        originalAmountMinor: 674_900,
        installmentIndex: 2,
        installmentMonths: 3,
        cuotaMinor: 224_967,
      }),
    ]));
  });

  it('maps Amex Aeromexico inline MSI cargo rows from tables', () => {
    const document = parseAmexStatementExtraction(aeromexico);
    expect(document.accountLastFour).toBe('1000');
    expect(document.product).toMatch(/Aeroméxico/i);
    const aero = document.charges.find((charge) => /AEROMEXICO/i.test(charge.merchantRaw) && charge.msi);
    expect(aero).toMatchObject({
      installmentIndex: 2,
      installmentMonths: 3,
      amountMinor: 150_867,
    });
    expect(document.msiPlans[0]).toMatchObject({
      merchantRaw: expect.stringMatching(/AEROMEXICO/i),
      originalAmountMinor: 452_600,
      installmentIndex: 2,
      installmentMonths: 3,
      cuotaMinor: 150_867,
    });
  });
});

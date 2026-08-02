import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAmexStatementExtraction } from '../lambda/amex-statement.js';
import type { TextractStatementExtraction } from '../lambda/textract-document.js';

const asLines = (raw: string): readonly string[] =>
  raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);

const goldLines = asLines(readFileSync(new URL('./fixtures/amex-gold-statement.txt', import.meta.url), 'utf8'));
const aeroLines = asLines(readFileSync(new URL('./fixtures/amex-aeromexico-statement.txt', import.meta.url), 'utf8'));
const goldExtraction = JSON.parse(
  readFileSync(new URL('./fixtures/amex-gold-extraction.json', import.meta.url), 'utf8'),
) as TextractStatementExtraction;

const fromLines = (
  provider: 'amex',
  lines: readonly string[],
): TextractStatementExtraction => ({
  provider,
  jobId: 'fixture-lines',
  status: 'SUCCEEDED',
  lines,
  text: lines.join('\n'),
  answers: {},
  queryAnswers: [],
  tables: [],
});

describe('parseAmexStatementExtraction', () => {
  it('maps Amex Gold MSI from AnalyzeDocument LINE blocks', () => {
    const document = parseAmexStatementExtraction(fromLines('amex', goldLines));
    expect(document.accountLastFour).toBe('1007');
    expect(document.period).toEqual({ from: '2026-06-07', to: '2026-07-06' });
    const msi = document.charges.filter((charge) => charge.msi);
    expect(msi.length).toBeGreaterThanOrEqual(2);
    expect(msi.some((charge) => charge.installmentIndex === 3 && charge.installmentMonths === 3 && charge.amountMinor === 82_532)).toBe(true);
    expect(msi.some((charge) => charge.installmentIndex === 2 && charge.amountMinor === 224_967)).toBe(true);
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

  it('maps Amex Aeromexico inline MSI cargo lines', () => {
    const document = parseAmexStatementExtraction(fromLines('amex', aeroLines));
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

  it('prefers query answers and table MSI when LINE layout is thin', () => {
    const document = parseAmexStatementExtraction(goldExtraction);
    expect(document.accountLastFour).toBe('1007');
    expect(document.period).toEqual({ from: '2026-06-07', to: '2026-07-06' });
    expect(document.charges.some((charge) => charge.msi && charge.amountMinor === 82_532)).toBe(true);
  });
});

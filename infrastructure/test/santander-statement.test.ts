import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSantanderStatementExtraction } from '../lambda/santander-statement.js';
import type { TextractStatementExtraction } from '../lambda/textract-document.js';

const asLines = (raw: string): readonly string[] =>
  raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);

const fixtureLines = asLines(
  readFileSync(new URL('./fixtures/santander-statement-ocr.txt', import.meta.url), 'utf8'),
);
const tableExtraction = JSON.parse(
  readFileSync(new URL('./fixtures/santander-statement-extraction.json', import.meta.url), 'utf8'),
) as TextractStatementExtraction;

describe('parseSantanderStatementExtraction', () => {
  it('maps period, card and MSI cuotas from AnalyzeDocument LINE blocks', () => {
    const document = parseSantanderStatementExtraction({
      provider: 'santander',
      jobId: 'fixture-lines',
      status: 'SUCCEEDED',
      lines: fixtureLines,
      text: fixtureLines.join('\n'),
      answers: {},
      queryAnswers: [],
      tables: [],
    });
    expect(document.accountLastFour).toBe('6349');
    expect(document.period).toEqual({ from: '2026-06-05', to: '2026-07-04' });
    expect(document.product).toMatch(/Unique Rewards/i);
    expect(document.msiCharges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        merchantRaw: 'AMAZON A MESES',
        amountMinor: 23_792,
        occurredOn: '2026-07-03',
        msi: true,
      }),
      expect.objectContaining({
        merchantRaw: 'AMAZON A MESES',
        amountMinor: 18_726,
        occurredOn: '2026-07-03',
        msi: true,
      }),
    ]));
    expect(document.charges.some((charge) => /MANGO/i.test(charge.merchantRaw) && charge.amountMinor === 302_600)).toBe(true);
    expect(document.charges.every((charge) => !charge.credit)).toBe(true);
  });

  it('maps MSI from Textract tables when present', () => {
    const document = parseSantanderStatementExtraction(tableExtraction);
    expect(document.accountLastFour).toBe('6349');
    expect(document.msiCharges.map((row) => row.amountMinor).sort()).toEqual([18_726, 23_792]);
  });

  it('tolerates noisy OCR separators around MSI rows', () => {
    const noisy = [
      'Periodo: 05-Jun-2026 al 04-Jul-2026',
      'Numero de tarjeta: 4262 8300 0028 6349',
      '03-Jul-2026_ [03-Jul-2026_ [AMAZON A MESES S 237.92',
      '03-Jul-2026_ [U3-Jul-2026_ [AMAZON A MESES S 187.26',
    ];
    const document = parseSantanderStatementExtraction({
      provider: 'santander',
      jobId: 'fixture-noisy',
      status: 'SUCCEEDED',
      lines: noisy,
      text: noisy.join('\n'),
      answers: {},
      queryAnswers: [],
      tables: [],
    });
    expect(document.msiCharges).toHaveLength(2);
    expect(document.msiCharges.map((row) => row.amountMinor).sort()).toEqual([18_726, 23_792]);
  });
});

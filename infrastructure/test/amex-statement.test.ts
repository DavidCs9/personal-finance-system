import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  amexMsiEvidenceLines,
  parseAmexStatementExtraction,
} from '../lambda/amex-statement.js';
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

  it('reads purchases when Textract puts the amount on the same dated line', () => {
    const document = parseAmexStatementExtraction(fromLines('amex', [
      'Período de Facturación Del 7 de Junio al 6 de Julio de 2026',
      'Número de Cuenta: 3717-797421-21007',
      'The Gold Elite Credit Card American Express',
      'Fecha y Detalle de las operaciones Importe en MN.',
      '7 de Junio CINEPOLIS WEB ALIMENTOS MI 192.00',
      '11 de Junio CARLS JR CANTERA CD JUAREZ 222.00',
      'Transacciones de Meses sin Intereses',
      '6 de Julio MESES EN AUTOMÁTICO NACIONAL CARGO 03 DE 03 825.32',
      'MESES EN AUTOMÁTICO NACIONAL Mensualidad=(Pago a capital + Interés + IVA)',
      '6 de May 2,476.00 0.00% 0.00 3 de 3 825.32',
    ]));
    expect(document.charges.filter((charge) => !charge.msi)).toEqual(expect.arrayContaining([
      expect.objectContaining({ merchantRaw: 'CINEPOLIS WEB ALIMENTOS MI', amountMinor: 19_200 }),
      expect.objectContaining({ merchantRaw: 'CARLS JR CANTERA CD JUAREZ', amountMinor: 22_200 }),
    ]));
    expect(document.charges.filter((charge) => charge.msi)).toHaveLength(1);
    expect(amexMsiEvidenceLines(document)).toEqual([
      expect.objectContaining({
        amountMinor: 82_532,
        installmentIndex: 3,
        installmentMonths: 3,
        originalAmountMinor: 247_600,
      }),
    ]);
  });

  it('dedupes MSI charge rows against plan summary rows', () => {
    const document = parseAmexStatementExtraction(fromLines('amex', goldLines));
    const evidence = amexMsiEvidenceLines(document);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((row) => row.amountMinor).sort((left, right) => left - right)).toEqual([82_532, 224_967]);
    expect(evidence.every((row) => row.originalAmountMinor !== undefined)).toBe(true);
  });
});

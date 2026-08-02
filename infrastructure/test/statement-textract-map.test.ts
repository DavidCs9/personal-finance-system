import { describe, expect, it } from 'vitest';
import { parseAmexStatementExtraction } from '../lambda/amex-statement.js';
import { parseSantanderStatementExtraction } from '../lambda/santander-statement.js';
import { findPeriodInLooseText, parseFlexibleDate } from '../lambda/statement-dates.js';
import { normalizeTextractAnalysis, textractLinesToText } from '../lambda/textract-document.js';

describe('statement date helpers', () => {
  it('parses Spanish query answers into ISO dates', () => {
    expect(parseFlexibleDate('7 de Junio de 2026')).toBe('2026-06-07');
    expect(parseFlexibleDate('05-Jun-2026')).toBe('2026-06-05');
  });

  it('finds Amex billing period in noisy LINE text', () => {
    expect(findPeriodInLooseText(
      'Periodo de Facturacion Del 7 de Junio al 6 de Julio de 2026 Dias del periodo',
    )).toEqual({ from: '2026-06-07', to: '2026-07-06' });
  });
});

describe('parseAmexStatementExtraction', () => {
  it('prefers Textract query answers for period and account', () => {
    const document = parseAmexStatementExtraction({
      provider: 'amex',
      jobId: 'job-1',
      status: 'SUCCEEDED',
      lines: [],
      text: '',
      answers: {
        PERIOD_FROM: '7 de Junio de 2026',
        PERIOD_TO: '6 de Julio de 2026',
        ACCOUNT_LAST_FOUR: '1007',
        PRODUCT: 'Gold Elite',
      },
      queryAnswers: [],
      tables: [{
        page: 1,
        rows: [
          ['6 de Julio', 'MESES EN AUTOMÁTICO NACIONAL', 'CARGO 03 DE 03', '825.32'],
        ],
      }],
    });
    expect(document.period).toEqual({ from: '2026-06-07', to: '2026-07-06' });
    expect(document.accountLastFour).toBe('1007');
    expect(document.charges.some((charge) => charge.msi && charge.amountMinor === 82_532)).toBe(true);
  });

  it('reads MSI rows from Textract tables', () => {
    const document = parseAmexStatementExtraction({
      provider: 'amex',
      jobId: 'job-2',
      status: 'SUCCEEDED',
      lines: [],
      text: '',
      answers: {
        PERIOD_TEXT: 'Del 7 de Junio al 6 de Julio de 2026',
        ACCOUNT_LAST_FOUR: '3717-797421-21007',
      },
      queryAnswers: [],
      tables: [{
        page: 1,
        rows: [
          ['6 de Julio', 'MESES EN AUTOMÁTICO NACIONAL', 'CARGO 02 DE 03', '2,249.67'],
        ],
      }],
    });
    expect(document.charges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        msi: true,
        amountMinor: 224_967,
        installmentIndex: 2,
        installmentMonths: 3,
      }),
    ]));
  });
});

describe('parseSantanderStatementExtraction', () => {
  it('uses query answers and table rows for MSI', () => {
    const document = parseSantanderStatementExtraction({
      provider: 'santander',
      jobId: 'job-3',
      status: 'SUCCEEDED',
      lines: [],
      text: '',
      answers: {
        PERIOD_FROM: '05-Jun-2026',
        PERIOD_TO: '04-Jul-2026',
        ACCOUNT_LAST_FOUR: '6349',
      },
      queryAnswers: [],
      tables: [{
        page: 2,
        rows: [
          ['03-Jul-2026', '03-Jul-2026', 'AMAZON A MESES', '$237.92'],
        ],
      }],
    });
    expect(document.period).toEqual({ from: '2026-06-05', to: '2026-07-04' });
    expect(document.accountLastFour).toBe('6349');
    expect(document.msiCharges).toEqual([
      expect.objectContaining({ merchantRaw: 'AMAZON A MESES', amountMinor: 23_792 }),
    ]);
  });
});

describe('normalizeTextractAnalysis', () => {
  it('maps QUERY/QUERY_RESULT and TABLE cells', () => {
    const extraction = normalizeTextractAnalysis('amex', 'job', 'SUCCEEDED', [
      { Id: 'q1', BlockType: 'QUERY', Query: { Alias: 'PERIOD_TO', Text: 'end?' }, Relationships: [{ Type: 'ANSWER', Ids: ['r1'] }] },
      { Id: 'r1', BlockType: 'QUERY_RESULT', Text: '6 de Julio de 2026', Confidence: 99 },
      { Id: 't1', BlockType: 'TABLE', Page: 1, Relationships: [{ Type: 'CHILD', Ids: ['c1', 'c2'] }] },
      { Id: 'c1', BlockType: 'CELL', RowIndex: 1, ColumnIndex: 1, Relationships: [{ Type: 'CHILD', Ids: ['w1'] }] },
      { Id: 'c2', BlockType: 'CELL', RowIndex: 1, ColumnIndex: 2, Text: '825.32' },
      { Id: 'w1', BlockType: 'WORD', Text: 'AMAZON' },
      { Id: 'l1', BlockType: 'LINE', Text: 'hello', Page: 1, Geometry: { BoundingBox: { Top: 0.1, Left: 0.1 } } },
    ]);
    expect(extraction.answers.PERIOD_TO).toBe('6 de Julio de 2026');
    expect(extraction.tables[0]?.rows[0]).toEqual(['AMAZON', '825.32']);
    expect(textractLinesToText([
      { BlockType: 'LINE', Text: 'b', Page: 1, Geometry: { BoundingBox: { Top: 0.2, Left: 0.1 } } },
      { BlockType: 'LINE', Text: 'a', Page: 1, Geometry: { BoundingBox: { Top: 0.1, Left: 0.1 } } },
    ])).toBe('a\nb');
  });
});

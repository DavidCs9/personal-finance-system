import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSantanderStatementText } from '../lambda/santander-statement.js';
import { textractLinesToText } from '../lambda/textract-document.js';

const fixture = readFileSync(new URL('./fixtures/santander-statement-ocr.txt', import.meta.url), 'utf8');

describe('parseSantanderStatementText', () => {
  it('parses period, card and MSI cuotas from statement text', () => {
    const document = parseSantanderStatementText(fixture);
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

  it('tolerates noisy OCR separators around MSI rows', () => {
    const noisy = [
      'Periodo: 05-Jun-2026 al 04-Jul-2026',
      'Numero de tarjeta: 4262 8300 0028 6349',
      '03-Jul-2026_ [03-Jul-2026_ [AMAZON A MESES S 237.92',
      '03-Jul-2026_ [U3-Jul-2026_ [AMAZON A MESES S 187.26',
    ].join('\n');
    const document = parseSantanderStatementText(noisy);
    expect(document.msiCharges).toHaveLength(2);
    expect(document.msiCharges.map((row) => row.amountMinor).sort()).toEqual([18_726, 23_792]);
  });
});

describe('textractLinesToText', () => {
  it('orders LINE blocks by page and geometry', () => {
    const text = textractLinesToText([
      { BlockType: 'LINE', Text: 'second', Page: 1, Geometry: { BoundingBox: { Top: 0.4, Left: 0.1 } } },
      { BlockType: 'LINE', Text: 'first', Page: 1, Geometry: { BoundingBox: { Top: 0.1, Left: 0.1 } } },
      { BlockType: 'LINE', Text: 'page2', Page: 2, Geometry: { BoundingBox: { Top: 0.1, Left: 0.1 } } },
    ]);
    expect(text).toBe('first\nsecond\npage2');
  });
});

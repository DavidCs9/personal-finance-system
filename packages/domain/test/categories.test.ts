import { describe, expect, it } from 'vitest';
import {
  aggregateSpendByCategory,
  normalizeMerchantKey,
  resolveCategoryId,
  spendAmountForMonth,
  suggestCategoryIdFromMerchant,
  type MerchantCategoryRule,
} from '@finance/domain';

describe('normalizeMerchantKey', () => {
  it('collapses accents and punctuation', () => {
    expect(normalizeMerchantKey('  Café-OXXO!!! ')).toBe('cafe oxxo');
  });
});

describe('resolveCategoryId', () => {
  const rules: readonly MerchantCategoryRule[] = [
    {
      id: '1',
      merchantKey: 'starbucks mx',
      categoryId: 'restaurantes',
      source: 'seed',
      updatedAt: '2026-08-01T00:00:00Z',
    },
    {
      id: '2',
      merchantKey: 'uber',
      pattern: 'uber',
      categoryId: 'transporte',
      source: 'seed',
      updatedAt: '2026-08-01T00:00:00Z',
    },
  ];

  it('matches exact then pattern', () => {
    expect(resolveCategoryId('STARBUCKS MX', rules)).toBe('restaurantes');
    expect(resolveCategoryId('UBER TRIP 123', rules)).toBe('transporte');
  });
});

describe('suggestCategoryIdFromMerchant', () => {
  it('suggests restaurantes for food merchants', () => {
    expect(suggestCategoryIdFromMerchant('Rappi Mexico')).toBe('restaurantes');
  });
});

describe('spendAmountForMonth', () => {
  it('uses MSI cuota spent for the month', () => {
    const amount = spendAmountForMonth(
      {
        amountMinor: 900_00,
        status: 'accepted',
        receivedAt: '2026-07-01T12:00:00Z',
        merchantRaw: 'Store',
        msi: {
          months: 3,
          principalMinor: 900_00,
          cuotaMinor: 300_00,
          installments: [
            { index: 1, month: '2026-07', amountMinor: 300_00, status: 'spent' },
            { index: 2, month: '2026-08', amountMinor: 300_00, status: 'spent' },
            { index: 3, month: '2026-09', amountMinor: 300_00, status: 'committed' },
          ],
        },
      },
      '2026-08',
    );
    expect(amount).toBe(300_00);
  });
});

describe('aggregateSpendByCategory', () => {
  it('warns uncategorized separately and aligns MSI', () => {
    const result = aggregateSpendByCategory(
      [
        {
          id: 'a',
          amountMinor: 100_00,
          status: 'accepted',
          receivedAt: '2026-08-01T12:00:00Z',
          merchantRaw: 'Cafe',
          categoryId: 'restaurantes',
        },
        {
          id: 'b',
          amountMinor: 50_00,
          status: 'accepted',
          receivedAt: '2026-08-02T12:00:00Z',
          merchantRaw: 'Mystery',
          categoryId: null,
        },
      ],
      '2026-08',
      new Map([['restaurantes', 'Restaurantes']]),
    );
    expect(result.totalSpentMinor).toBe(150_00);
    expect(result.uncategorizedMinor).toBe(50_00);
    expect(result.buckets.find((bucket) => bucket.key === 'restaurantes')?.amountMinor).toBe(100_00);
  });
});

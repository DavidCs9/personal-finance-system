import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEND_CATEGORIES,
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

  it('keeps uber eats as restaurantes, not transporte', () => {
    expect(suggestCategoryIdFromMerchant('UBER EATS https://help.ub')).toBe('restaurantes');
    expect(suggestCategoryIdFromMerchant('UBER TRIP https://help.ub')).toBe('transporte');
  });

  it('matches normalized subscription merchants', () => {
    expect(suggestCategoryIdFromMerchant('APPLE.COM/BILL CUPERTINO')).toBe('suscripciones');
    expect(suggestCategoryIdFromMerchant('CLAUDE.AI SUBSCRIPTION SAN FRANCISCO')).toBe('suscripciones');
  });

  it('matches Mexican bank REST* and OXXO abbreviations', () => {
    expect(suggestCategoryIdFromMerchant('REST SANTI MARISCOS')).toBe('restaurantes');
    expect(suggestCategoryIdFromMerchant('OXXO HDAS DE VALLE CUF')).toBe('supermercado');
    expect(suggestCategoryIdFromMerchant('ALSUPER SANTA FE ALSUPE CHIHUAHUA, CHIH')).toBe('supermercado');
  });

  it('keeps sport venues out of entertainment and health', () => {
    expect(suggestCategoryIdFromMerchant('PADEL HOUSE CHIHUAHUA')).toBe('deportes');
    expect(suggestCategoryIdFromMerchant('ANYTIME FITNESS')).toBe('deportes');
  });
});

describe('DEFAULT_SPEND_CATEGORIES', () => {
  it('includes Deportes in the fixed V1 catalog', () => {
    expect(DEFAULT_SPEND_CATEGORIES).toContainEqual({ id: 'deportes', name: 'Deportes', sortOrder: 75 });
  });
});

describe('spendAmountForMonth', () => {
  it('uses Mi parte for a shared non-MSI purchase', () => {
    expect(spendAmountForMonth({
      amountMinor: 900_00,
      personalAmountMinor: 225_00,
      status: 'accepted',
      receivedAt: '2026-08-01T12:00:00Z',
    }, '2026-08')).toBe(225_00);
  });

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

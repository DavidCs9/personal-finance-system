import { describe, expect, it } from 'vitest';
import { findDeferralPurchaseSubset } from '../lambda/amex-deferral.js';

describe('findDeferralPurchaseSubset', () => {
  it('matches a single purchase to the deferral credit', () => {
    expect(findDeferralPurchaseSubset(
      [
        { id: 'gob', amountMinor: 247_600 },
        { id: 'small', amountMinor: 15_000 },
      ],
      247_600,
    )).toEqual(['gob']);
  });

  it('matches Costco + Globale to the consolidated MONTO A DIFERIR', () => {
    expect(findDeferralPurchaseSubset(
      [
        { id: 'costco', amountMinor: 309_900 },
        { id: 'globale', amountMinor: 365_000 },
        { id: 'other', amountMinor: 50_000 },
      ],
      674_900,
    )).toEqual(['globale', 'costco']);
  });

  it('returns undefined when no subset fits', () => {
    expect(findDeferralPurchaseSubset(
      [
        { id: 'a', amountMinor: 100_000 },
        { id: 'b', amountMinor: 200_000 },
      ],
      674_900,
    )).toBeUndefined();
  });
});

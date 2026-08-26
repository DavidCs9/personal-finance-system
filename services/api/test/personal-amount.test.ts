import { describe, expect, it } from 'vitest';
import { parsePersonalAmountMinor } from '../src/events/personal-amount.js';

describe('parsePersonalAmountMinor', () => {
  it('accepts zero, partial, and full allocations', () => {
    expect(parsePersonalAmountMinor(0, 1_000_00)).toBe(0);
    expect(parsePersonalAmountMinor(250_00, 1_000_00)).toBe(250_00);
    expect(parsePersonalAmountMinor(1_000_00, 1_000_00)).toBe(1_000_00);
  });

  it('rejects negative, fractional, and above-gross allocations', () => {
    expect(() => parsePersonalAmountMinor(-1, 1_000_00)).toThrow();
    expect(() => parsePersonalAmountMinor(1.5, 1_000_00)).toThrow();
    expect(() => parsePersonalAmountMinor(1_000_01, 1_000_00)).toThrow();
  });

  it('rejects missing, null, and string allocations instead of coercing them', () => {
    expect(() => parsePersonalAmountMinor(undefined, 1_000_00)).toThrow();
    expect(() => parsePersonalAmountMinor(null, 1_000_00)).toThrow();
    expect(() => parsePersonalAmountMinor('25000', 1_000_00)).toThrow();
  });
});

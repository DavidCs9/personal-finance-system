import { describe, expect, it } from 'vitest';
import {
  InvalidWealthSnapshotError,
  parseCashSnapshot,
  parseCardLiabilitySnapshot,
} from '../src/wealth/input.js';

describe('parseCashSnapshot', () => {
  it('accepts a positive MXN amount in minor units', () => {
    expect(parseCashSnapshot(JSON.stringify({ amountMinor: 12_500 }), false)).toEqual({
      amountMinor: 12_500,
    });
  });

  it('rejects non-positive amounts', () => {
    expect(() => parseCashSnapshot(JSON.stringify({ amountMinor: 0 }), false)).toThrow(InvalidWealthSnapshotError);
  });
});

describe('parseCardLiabilitySnapshot', () => {
  it('accepts zero and positive amounts', () => {
    expect(parseCardLiabilitySnapshot(JSON.stringify({ amountMinor: 0 }))).toEqual({ amountMinor: 0 });
    expect(parseCardLiabilitySnapshot(JSON.stringify({ amountMinor: 45_000 }))).toEqual({
      amountMinor: 45_000,
    });
  });

  it('rejects negative amounts', () => {
    expect(() => parseCardLiabilitySnapshot(JSON.stringify({ amountMinor: -1 }))).toThrow(
      InvalidWealthSnapshotError,
    );
  });
});

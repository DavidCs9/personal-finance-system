import { describe, expect, it } from 'vitest';
import {
  InvalidWealthSnapshotError,
  parseCajitaSnapshot,
  parseCardLiabilitySnapshot,
} from '../src/wealth/input.js';

describe('parseCajitaSnapshot', () => {
  it('accepts a positive MXN amount in minor units', () => {
    expect(parseCajitaSnapshot(JSON.stringify({ amountMinor: 12_500 }))).toEqual({
      amountMinor: 12_500,
    });
  });

  it('rejects non-positive amounts', () => {
    expect(() => parseCajitaSnapshot(JSON.stringify({ amountMinor: 0 }))).toThrow(InvalidWealthSnapshotError);
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

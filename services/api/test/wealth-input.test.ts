import { describe, expect, it } from 'vitest';
import { InvalidWealthSnapshotError, parseCajitaSnapshot } from '../src/wealth/input.js';

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

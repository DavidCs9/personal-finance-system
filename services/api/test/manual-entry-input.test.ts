import { describe, expect, it } from 'vitest';
import {
  InvalidManualEntryError,
  manualEntryFingerprint,
  parseManualEntry,
} from '../src/events/manual-entry-input.js';

describe('manual entry input', () => {
  it('parses a complete Amex manual charge', () => {
    expect(parseManualEntry(JSON.stringify({
      institution: 'american_express_mx',
      merchantRaw: ' Amazon MX ',
      amountMinor: 129900,
      currency: 'MXN',
      occurredOn: '2026-08-01',
      accountLastFour: '1234',
      note: 'No llegó el correo',
    }))).toEqual({
      institution: 'american_express_mx',
      merchantRaw: 'Amazon MX',
      amountMinor: 129900,
      currency: 'MXN',
      occurredOn: '2026-08-01',
      occurredAt: '2026-08-01T12:00:00.000Z',
      accountLastFour: '1234',
      note: 'No llegó el correo',
    });
  });

  it('derives occurredOn from a full occurredAt timestamp', () => {
    expect(parseManualEntry(JSON.stringify({
      institution: 'american_express_mx',
      merchantRaw: 'Café',
      amountMinor: 4500,
      occurredAt: '2026-08-01T19:30:00-06:00',
    }))).toMatchObject({
      occurredOn: '2026-08-01',
      occurredAt: '2026-08-02T01:30:00.000Z',
    });
  });

  it('rejects invalid institutions and amounts', () => {
    expect(() => parseManualEntry(JSON.stringify({
      institution: 'visa',
      merchantRaw: 'X',
      amountMinor: 100,
      occurredOn: '2026-08-01',
    }))).toThrow(InvalidManualEntryError);

    expect(() => parseManualEntry(JSON.stringify({
      institution: 'american_express_mx',
      merchantRaw: 'X',
      amountMinor: 12.5,
      occurredOn: '2026-08-01',
    }))).toThrow(InvalidManualEntryError);
  });

  it('builds a stable fingerprint for idempotent retries', () => {
    const input = parseManualEntry(JSON.stringify({
      institution: 'american_express_mx',
      merchantRaw: 'Amazon MX',
      amountMinor: 129900,
      occurredOn: '2026-08-01',
      accountLastFour: '1234',
    }));
    const again = parseManualEntry(JSON.stringify({
      institution: 'american_express_mx',
      merchantRaw: ' amazon  mx ',
      amountMinor: 129900,
      occurredOn: '2026-08-01',
      accountLastFour: '1234',
      note: 'different note should not change identity',
    }));
    expect(manualEntryFingerprint('owner-1', input)).toBe(manualEntryFingerprint('owner-1', again));
    expect(manualEntryFingerprint('owner-1', input)).not.toBe(manualEntryFingerprint('owner-2', input));
  });
});

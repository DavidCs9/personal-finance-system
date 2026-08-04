import { describe, expect, it } from 'vitest';
import { InvalidApplePayCaptureError, parseApplePayCapture, parseCurrencyAmount } from '../src/apple-pay/apple-pay-input.js';

describe('Apple Pay capture input', () => {
  it.each([
    ['$1,234.56', 123456],
    ['MXN 1,234.56', 123456],
    ['1.234,56 MXN', 123456],
    ['$115', 11500],
    ['$115.5', 11550],
  ])('converts %s into integer minor units', (raw, expected) => {
    expect(parseCurrencyAmount(raw)).toBe(expected);
  });

  it('parses a complete Santander Shortcut payload', () => {
    expect(parseApplePayCapture(JSON.stringify({
      requestId: 'capture_12345678',
      amountRaw: '$259.90',
      merchantRaw: ' COSTCO CHIHUAHUA ',
      cardRaw: 'Santander LikeU',
      nameRaw: 'Costco',
      occurredAt: '2026-08-01T19:30:00-06:00',
      institution: 'santander_mx',
      currency: 'MXN',
    }), 'capture_12345678')).toEqual({
      requestId: 'capture_12345678',
      amountRaw: '$259.90',
      amountMinor: 25990,
      merchantRaw: 'COSTCO CHIHUAHUA',
      cardRaw: 'Santander LikeU',
      nameRaw: 'Costco',
      occurredAt: '2026-08-02T01:30:00.000Z',
      institution: 'santander_mx',
      currency: 'MXN',
    });
  });

  it('requires the body request ID to match the idempotency header', () => {
    expect(() => parseApplePayCapture(JSON.stringify({
      requestId: 'capture_12345678',
      amountRaw: '$10.00',
      merchantRaw: 'Cafe',
      cardRaw: 'Santander',
      occurredAt: '2026-08-01T19:30:00-06:00',
      institution: 'santander_mx',
      currency: 'MXN',
    }), 'capture_87654321')).toThrow(InvalidApplePayCaptureError);
  });
});

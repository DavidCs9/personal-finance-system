import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidPushSubscriptionError,
  parsePushSubscriptionInput,
  pushSubscriptionId,
} from '../src/push-subscriptions.js';
import {
  declarativeWebPushPayload,
  formatAmount,
  observedPurchasePushMessage,
} from '../src/push-notify.js';
import { generateVapidKeys } from '../../../infrastructure/lambda/vapid-keys.js';

describe('pushSubscriptionId', () => {
  it('hashes the endpoint with sha256 hex', () => {
    const endpoint = 'https://web.push.apple.com/example';
    expect(pushSubscriptionId(endpoint)).toBe(createHash('sha256').update(endpoint).digest('hex'));
  });
});

describe('parsePushSubscriptionInput', () => {
  const endpoint = 'https://web.push.apple.com/example-subscription';
  const subscriptionId = pushSubscriptionId(endpoint);

  it('accepts a valid HTTPS subscription', () => {
    expect(parsePushSubscriptionInput(JSON.stringify({
      endpoint,
      keys: { p256dh: 'abc123_-', auth: 'def456_-' },
      contentMode: 'private',
    }), subscriptionId)).toEqual({
      endpoint,
      keys: { p256dh: 'abc123_-', auth: 'def456_-' },
      contentMode: 'private',
    });
  });

  it('rejects mismatched subscription ids', () => {
    expect(() => parsePushSubscriptionInput(JSON.stringify({
      endpoint,
      keys: { p256dh: 'abc123_-', auth: 'def456_-' },
    }), '0'.repeat(64))).toThrow(InvalidPushSubscriptionError);
  });

  it('rejects non-HTTPS endpoints', () => {
    const httpEndpoint = 'http://example.com/push';
    expect(() => parsePushSubscriptionInput(JSON.stringify({
      endpoint: httpEndpoint,
      keys: { p256dh: 'abc123_-', auth: 'def456_-' },
    }), pushSubscriptionId(httpEndpoint))).toThrow(/HTTPS/);
  });
});

describe('observedPurchasePushMessage', () => {
  const purchase = {
    id: 'event-1',
    merchantRaw: 'Café Central',
    amount: { amountMinor: 12550, currency: 'MXN' },
    institution: 'santander_mx',
  };

  it('includes amounts by default', () => {
    expect(observedPurchasePushMessage(purchase, 'amounts', 'https://finance.castrodavid.dev/')).toEqual({
      title: 'Olbia · movimiento nuevo',
      body: 'Café Central: 125.50 MXN',
      tag: 'observed-event-1',
      navigate: 'https://finance.castrodavid.dev/',
    });
  });

  it('hides amounts in private mode', () => {
    expect(observedPurchasePushMessage(purchase, 'private', 'https://finance.castrodavid.dev/').body)
      .toBe('Hay un movimiento nuevo.');
  });

  it('builds a declarative web push payload', () => {
    const message = observedPurchasePushMessage(purchase, 'amounts', 'https://finance.castrodavid.dev/');
    expect(JSON.parse(declarativeWebPushPayload(message))).toEqual({
      web_push: 8030,
      notification: {
        title: message.title,
        body: message.body,
        navigate: message.navigate,
        lang: 'es-MX',
        silent: false,
        tag: message.tag,
      },
    });
  });
});

describe('formatAmount', () => {
  it('formats minor units with currency', () => {
    expect(formatAmount({ amountMinor: 100, currency: 'MXN' })).toBe('1.00 MXN');
  });
});

describe('generateVapidKeys', () => {
  it('returns base64url public and private keys', () => {
    const keys = generateVapidKeys('mailto:alerts@finance.castrodavid.dev');
    expect(keys.subject).toBe('mailto:alerts@finance.castrodavid.dev');
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.publicKey.length).toBeGreaterThan(20);
    expect(keys.privateKey.length).toBeGreaterThan(20);
  });
});

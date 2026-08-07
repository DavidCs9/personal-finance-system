import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  bitsoAuthHeader,
  bitsoNonceV2,
  buildBitsoHoldings,
  fetchBitsoBalances,
  isBitsoCredentialsConfigured,
  mxnRateForCurrency,
} from '../src/wealth/bitso-client.js';

describe('bitsoAuthHeader', () => {
  it('signs method + path with HMAC-SHA256', () => {
    const nonce = '1700000000000123456';
    const credentials = { apiKey: 'key', apiSecret: 'secret' };
    const header = bitsoAuthHeader(credentials, 'GET', '/api/v3/balance/', '', nonce);
    const expected = createHmac('sha256', 'secret')
      .update(`${nonce}GET/api/v3/balance/`)
      .digest('hex');
    expect(header).toBe(`Bitso key:${nonce}:${expected}`);
  });
});

describe('bitsoNonceV2', () => {
  it('concatenates a 13-digit timestamp with a 6-digit salt', () => {
    const nonce = bitsoNonceV2(1_731_349_200_123);
    expect(nonce).toMatch(/^1731349200123\d{6}$/);
    expect(nonce).toHaveLength(19);
  });
});

describe('isBitsoCredentialsConfigured', () => {
  it('rejects pending placeholders', () => {
    expect(isBitsoCredentialsConfigured({
      apiKey: 'pending',
      apiSecret: 'pending',
    })).toBe(false);
  });

  it('accepts real credentials', () => {
    expect(isBitsoCredentialsConfigured({
      apiKey: 'real-key',
      apiSecret: 'real-secret',
    })).toBe(true);
  });
});

describe('fetchBitsoBalances', () => {
  it('parses balance payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      payload: {
        balances: [
          { currency: 'mxn', total: '100.5', locked: '0', available: '100.5' },
          { currency: 'btc', total: '0.01', locked: '0', available: '0.01' },
        ],
      },
    }), { status: 200 }));
    await expect(fetchBitsoBalances({ apiKey: 'k', apiSecret: 's' }, fetchImpl)).resolves.toEqual([
      { currency: 'mxn', total: 100.5, locked: 0, available: 100.5 },
      { currency: 'btc', total: 0.01, locked: 0, available: 0.01 },
    ]);
  });
});

describe('mxnRateForCurrency', () => {
  it('returns 1 for mxn', async () => {
    await expect(mxnRateForCurrency('mxn')).resolves.toBe(1);
  });

  it('reads ticker last price', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      payload: { book: 'btc_mxn', last: '1000000' },
    }), { status: 200 }));
    await expect(mxnRateForCurrency('btc', fetchImpl)).resolves.toBe(1_000_000);
  });
});

describe('buildBitsoHoldings', () => {
  it('values balances with MXN tickers and skips unknown books', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('btc_mxn')) {
        return new Response(JSON.stringify({
          success: true,
          payload: { book: 'btc_mxn', last: '1000000' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: false,
        error: { message: 'Unknown book' },
      }), { status: 400 });
    });

    const result = await buildBitsoHoldings(
      [
        { currency: 'mxn', total: 250 },
        { currency: 'btc', total: 0.01 },
        { currency: 'zzz', total: 3 },
      ],
      fetchImpl,
    );

    expect(result.skipped).toEqual(['zzz']);
    expect(result.holdings).toEqual([
      {
        id: 'bitso:btc',
        symbol: 'BTC',
        name: 'BTC',
        quantity: 0.01,
        currency: 'BTC',
        valueNativeMinor: 1_000_000,
        valueMxnMinor: 10_000_00,
      },
      {
        id: 'bitso:mxn',
        symbol: 'MXN',
        name: 'Efectivo MXN',
        quantity: 250,
        currency: 'MXN',
        valueNativeMinor: 25_000,
        valueMxnMinor: 25_000,
      },
    ]);
    expect(result.rates).toEqual({ mxn: 1, btc: 1_000_000 });
  });
});

import { createHmac } from 'node:crypto';
import type { WealthHolding } from '@finance/domain';

const BITSO_API_BASE = 'https://api.bitso.com';

export interface BitsoCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface BitsoBalance {
  readonly currency: string;
  readonly total: number;
  readonly locked: number;
  readonly available: number;
}

export interface BitsoTicker {
  readonly book: string;
  readonly last: number;
}

export class BitsoApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'BitsoApiError';
  }
}

export const isBitsoCredentialsConfigured = (value: unknown): value is BitsoCredentials => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.apiKey === 'string'
    && record.apiKey.trim().length > 0
    && record.apiKey !== 'pending'
    && typeof record.apiSecret === 'string'
    && record.apiSecret.trim().length > 0
    && record.apiSecret !== 'pending';
};

export const bitsoAuthHeader = (
  credentials: BitsoCredentials,
  method: string,
  requestPath: string,
  jsonPayload = '',
  nonce: number = Date.now(),
): string => {
  const message = `${nonce}${method.toUpperCase()}${requestPath}${jsonPayload}`;
  const signature = createHmac('sha256', credentials.apiSecret).update(message).digest('hex');
  return `Bitso ${credentials.apiKey}:${nonce}:${signature}`;
};

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || body.success === false) {
    const error = body.error && typeof body.error === 'object'
      ? (body.error as { message?: unknown }).message
      : undefined;
    throw new BitsoApiError(
      typeof error === 'string' ? error : `Bitso request failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  return body;
};

export const fetchBitsoBalances = async (
  credentials: BitsoCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly BitsoBalance[]> => {
  const path = '/api/v3/balance/';
  const response = await fetchImpl(`${BITSO_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: bitsoAuthHeader(credentials, 'GET', path),
      Accept: 'application/json',
    },
  });
  const body = await parseJson(response);
  const payload = body.payload as { balances?: unknown } | undefined;
  if (!payload || !Array.isArray(payload.balances)) {
    throw new BitsoApiError('Bitso balance payload was missing balances.');
  }
  return payload.balances.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (typeof item.currency !== 'string') return [];
    const total = Number(item.total);
    const locked = Number(item.locked);
    const available = Number(item.available);
    if (![total, locked, available].every(Number.isFinite)) return [];
    return [{
      currency: item.currency.toLowerCase(),
      total,
      locked,
      available,
    }];
  });
};

export const fetchBitsoTicker = async (
  book: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BitsoTicker> => {
  const path = `/api/v3/ticker?book=${encodeURIComponent(book)}`;
  const response = await fetchImpl(`${BITSO_API_BASE}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const body = await parseJson(response);
  const payload = body.payload as Record<string, unknown> | undefined;
  const last = Number(payload?.last);
  if (!payload || !Number.isFinite(last) || last <= 0) {
    throw new BitsoApiError(`Bitso ticker for ${book} did not include a positive last price.`);
  }
  return { book, last };
};

/** MXN per 1 unit of currency. MXN itself is 1. */
export const mxnRateForCurrency = async (
  currency: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> => {
  if (currency === 'mxn') return 1;
  const ticker = await fetchBitsoTicker(`${currency}_mxn`, fetchImpl);
  return ticker.last;
};

const nativeMinorScale = (currency: string): number => {
  if (currency === 'mxn' || currency === 'usd' || currency === 'eur') return 100;
  return 100_000_000;
};

const holdingName = (currency: string): string => {
  if (currency === 'mxn') return 'Efectivo MXN';
  if (currency === 'usd') return 'Efectivo USD';
  return currency.toUpperCase();
};

export const buildBitsoHoldings = async (
  balances: readonly { readonly currency: string; readonly total: number }[],
  fetchImpl: typeof fetch = fetch,
): Promise<{
  readonly holdings: readonly WealthHolding[];
  readonly rates: Readonly<Record<string, number>>;
  readonly skipped: readonly string[];
}> => {
  const holdings: WealthHolding[] = [];
  const rates: Record<string, number> = {};
  const skipped: string[] = [];

  for (const balance of balances) {
    if (!(balance.total > 0)) continue;
    try {
      const rate = await mxnRateForCurrency(balance.currency, fetchImpl);
      rates[balance.currency] = rate;
      const scale = nativeMinorScale(balance.currency);
      const valueMxnMinor = Math.round(balance.total * rate * 100);
      if (valueMxnMinor <= 0) continue;
      holdings.push({
        id: `bitso:${balance.currency}`,
        symbol: balance.currency.toUpperCase(),
        name: holdingName(balance.currency),
        quantity: balance.total,
        currency: balance.currency.toUpperCase(),
        valueNativeMinor: Math.round(balance.total * scale),
        valueMxnMinor,
      });
    } catch {
      skipped.push(balance.currency);
    }
  }

  holdings.sort((left, right) => right.valueMxnMinor - left.valueMxnMinor || left.symbol.localeCompare(right.symbol));
  return { holdings, rates, skipped };
};

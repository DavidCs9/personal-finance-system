import type { WealthHolding } from '@finance/domain';

const FLEX_BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const USER_AGENT = 'Olbia-Personal-Finance/1.0';

export interface IbkrFlexCredentials {
  readonly flexToken: string;
  readonly flexQueryId: string;
}

export class IbkrFlexError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'IbkrFlexError';
  }
}

export const isIbkrFlexCredentialsConfigured = (value: unknown): value is IbkrFlexCredentials => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.flexToken === 'string'
    && record.flexToken.trim().length > 0
    && record.flexToken !== 'pending'
    && typeof record.flexQueryId === 'string'
    && record.flexQueryId.trim().length > 0
    && record.flexQueryId !== 'pending';
};

const xmlTagText = (xml: string, tag: string): string | undefined => {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match?.[1]?.trim();
};

const xmlAttr = (attrs: string, name: string): string | undefined => {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
    ?? attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return match?.[1]?.trim();
};

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized || normalized === 'N/A' || normalized === '--') return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export interface FlexOpenPosition {
  readonly symbol: string;
  readonly name: string;
  readonly quantity: number;
  readonly currency: string;
  readonly positionValue: number;
  readonly assetCategory?: string;
  readonly conid?: string;
}

export interface FlexCashBalance {
  readonly currency: string;
  readonly endingCash: number;
}

/** Pull self-closing or open OpenPosition elements from Flex XML. */
export const parseFlexOpenPositions = (xml: string): readonly FlexOpenPosition[] => {
  const positions: FlexOpenPosition[] = [];
  const pattern = /<OpenPosition\b([^>]*?)(?:\/>|>([\s\S]*?)<\/OpenPosition>)/gi;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const symbol = xmlAttr(attrs, 'symbol') ?? xmlAttr(attrs, 'ticker') ?? '';
    const qty = parseNumber(xmlAttr(attrs, 'position') ?? xmlAttr(attrs, 'quantity'));
    const positionValue = parseNumber(
      xmlAttr(attrs, 'positionValue')
      ?? xmlAttr(attrs, 'value')
      ?? xmlAttr(attrs, 'marketValue'),
    );
    const currency = (
      xmlAttr(attrs, 'currency')
      ?? xmlAttr(attrs, 'currencyPrimary')
      ?? 'USD'
    ).toUpperCase();
    if (!symbol || qty === undefined || !(Math.abs(qty) > 0) || positionValue === undefined) continue;
    positions.push({
      symbol: symbol.toUpperCase(),
      name: xmlAttr(attrs, 'description') ?? xmlAttr(attrs, 'name') ?? symbol.toUpperCase(),
      quantity: qty,
      currency,
      positionValue: Math.abs(positionValue),
      ...(xmlAttr(attrs, 'assetCategory') || xmlAttr(attrs, 'assetClass')
        ? { assetCategory: (xmlAttr(attrs, 'assetCategory') ?? xmlAttr(attrs, 'assetClass')) }
        : {}),
      ...(xmlAttr(attrs, 'conid') ? { conid: xmlAttr(attrs, 'conid') } : {}),
    });
  }
  return positions;
};

export const parseFlexCashBalances = (xml: string): readonly FlexCashBalance[] => {
  const balances: FlexCashBalance[] = [];
  const pattern = /<CashReportCurrency\b([^>]*?)(?:\/>|>([\s\S]*?)<\/CashReportCurrency>)/gi;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const currency = (xmlAttr(attrs, 'currency') ?? '').toUpperCase();
    const endingCash = parseNumber(
      xmlAttr(attrs, 'endingCash')
      ?? xmlAttr(attrs, 'endingSettledCash')
      ?? xmlAttr(attrs, 'cash'),
    );
    if (!currency || endingCash === undefined || !(Math.abs(endingCash) > 0.000_000_1)) continue;
    // Skip BASE rollups that duplicate currency rows when present.
    if (currency === 'BASE') continue;
    balances.push({ currency, endingCash });
  }
  return balances;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const sendFlexRequest = async (
  credentials: IbkrFlexCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly referenceCode: string; readonly url?: string }> => {
  const url = `${FLEX_BASE}/SendRequest?t=${encodeURIComponent(credentials.flexToken)}&q=${encodeURIComponent(credentials.flexQueryId)}&v=3`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,*/*' },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new IbkrFlexError(`Flex SendRequest failed with HTTP ${response.status}.`, response.status);
  }
  const status = xmlTagText(body, 'Status');
  if (status && status.toLowerCase() !== 'success') {
    throw new IbkrFlexError(xmlTagText(body, 'ErrorMessage') ?? `Flex SendRequest status=${status}.`);
  }
  const referenceCode = xmlTagText(body, 'ReferenceCode');
  if (!referenceCode) throw new IbkrFlexError('Flex SendRequest did not return a ReferenceCode.');
  return {
    referenceCode,
    ...(xmlTagText(body, 'Url') ? { url: xmlTagText(body, 'Url') } : {}),
  };
};

export const getFlexStatement = async (
  credentials: IbkrFlexCredentials,
  referenceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> => {
  const url = `${FLEX_BASE}/GetStatement?t=${encodeURIComponent(credentials.flexToken)}&q=${encodeURIComponent(referenceCode)}&v=3`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,*/*' },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new IbkrFlexError(`Flex GetStatement failed with HTTP ${response.status}.`, response.status);
  }
  const status = xmlTagText(body, 'Status');
  if (status && status.toLowerCase() !== 'success' && !body.includes('<FlexQueryResponse') && !body.includes('<OpenPosition')) {
    const code = xmlTagText(body, 'ErrorCode');
    // 1019 / 1009 often mean "statement generation in progress".
    if (code === '1019' || code === '1009' || /in progress|please try again/i.test(body)) {
      throw new IbkrFlexError('STATEMENT_PENDING', response.status);
    }
    throw new IbkrFlexError(xmlTagText(body, 'ErrorMessage') ?? `Flex GetStatement status=${status}.`);
  }
  if (!body.includes('<FlexQueryResponse') && !body.includes('<OpenPosition') && !body.includes('<CashReport')) {
    if (/in progress|please try again|not available/i.test(body) || xmlTagText(body, 'ErrorCode')) {
      throw new IbkrFlexError('STATEMENT_PENDING', response.status);
    }
  }
  return body;
};

export const fetchFlexStatementXml = async (
  credentials: IbkrFlexCredentials,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly maxAttempts?: number;
    readonly delayMs?: number;
  } = {},
): Promise<string> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 20;
  const delayMs = options.delayMs ?? 2_000;
  const { referenceCode } = await sendFlexRequest(credentials, fetchImpl);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await getFlexStatement(credentials, referenceCode, fetchImpl);
    } catch (error) {
      const pending = error instanceof IbkrFlexError && error.message === 'STATEMENT_PENDING';
      if (!pending || attempt === maxAttempts) throw error;
      await sleep(delayMs);
    }
  }
  throw new IbkrFlexError('Flex statement was still pending after retries.');
};

/** MXN per 1 USD from Banxico FIX (SF43718). */
export const fetchBanxicoUsdMxnFix = async (
  banxicoToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly rate: number; readonly fecha?: string }> => {
  const url = 'https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718/datos/oportuno';
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      'Bmx-Token': banxicoToken,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new IbkrFlexError(`Banxico FIX request failed with HTTP ${response.status}.`, response.status);
  }
  const body = await response.json() as {
    bmx?: { series?: Array<{ datos?: Array<{ fecha?: string; dato?: string }> }> };
  };
  const latest = body.bmx?.series?.[0]?.datos?.[0];
  const rate = parseNumber(latest?.dato);
  if (!rate || !(rate > 0)) throw new IbkrFlexError('Banxico FIX did not return a positive USD/MXN rate.');
  return { rate, ...(latest?.fecha ? { fecha: latest.fecha } : {}) };
};

export const isBanxicoTokenConfigured = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim() !== 'pending';

const usdToMxnMinor = (usdAmount: number, usdMxn: number): number =>
  Math.round(usdAmount * usdMxn * 100);

export const buildIbkrHoldings = (
  positions: readonly FlexOpenPosition[],
  cash: readonly FlexCashBalance[],
  usdMxn: number,
): {
  readonly holdings: readonly WealthHolding[];
  readonly skipped: readonly string[];
} => {
  const holdings: WealthHolding[] = [];
  const skipped: string[] = [];

  for (const position of positions) {
    if (position.currency !== 'USD') {
      skipped.push(`${position.symbol}:${position.currency}`);
      continue;
    }
    const valueMxnMinor = usdToMxnMinor(position.positionValue, usdMxn);
    if (valueMxnMinor <= 0) continue;
    holdings.push({
      id: `ibkr:${position.conid ?? position.symbol}`,
      symbol: position.symbol,
      name: position.name,
      quantity: position.quantity,
      currency: 'USD',
      valueNativeMinor: Math.round(position.positionValue * 100),
      valueMxnMinor,
    });
  }

  for (const balance of cash) {
    if (balance.currency !== 'USD') {
      skipped.push(`cash:${balance.currency}`);
      continue;
    }
    const valueMxnMinor = usdToMxnMinor(balance.endingCash, usdMxn);
    if (valueMxnMinor === 0) continue;
    holdings.push({
      id: 'ibkr:cash:USD',
      symbol: 'USD',
      name: 'Efectivo USD',
      quantity: balance.endingCash,
      currency: 'USD',
      valueNativeMinor: Math.round(balance.endingCash * 100),
      valueMxnMinor,
    });
  }

  holdings.sort((left, right) => right.valueMxnMinor - left.valueMxnMinor || left.symbol.localeCompare(right.symbol));
  return { holdings, skipped };
};

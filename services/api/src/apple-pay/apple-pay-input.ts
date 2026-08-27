export class InvalidApplePayCaptureError extends Error {}

export interface ApplePayCaptureInput {
  readonly requestId: string;
  readonly amountRaw: string;
  readonly amountMinor: number;
  readonly merchantRaw: string;
  readonly cardRaw: string;
  readonly nameRaw?: string;
  readonly occurredAt: string;
  readonly institution: 'santander_mx';
  readonly currency: 'MXN' | 'USD';
}

type JsonObject = Record<string, unknown>;

const requiredText = (body: JsonObject, key: string, maxLength: number): string => {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new InvalidApplePayCaptureError(`${key} must be non-empty text with at most ${maxLength} characters.`);
  }
  return value.trim();
};

export const parseCurrencyAmount = (raw: string): number => {
  const compact = raw.trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!compact || compact.startsWith('-') || (compact.match(/-/g)?.length ?? 0) > 0) {
    throw new InvalidApplePayCaptureError('amountRaw must contain a positive amount.');
  }
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  const decimalSeparator = lastComma >= 0 && lastDot >= 0
    ? (lastComma > lastDot ? ',' : '.')
    : (() => {
        const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : undefined;
        if (!separator) return undefined;
        const digitsAfter = compact.length - compact.lastIndexOf(separator) - 1;
        return digitsAfter === 1 || digitsAfter === 2 ? separator : undefined;
      })();
  const decimalIndex = decimalSeparator ? compact.lastIndexOf(decimalSeparator) : -1;
  const wholeRaw = decimalIndex >= 0 ? compact.slice(0, decimalIndex) : compact;
  const fractionRaw = decimalIndex >= 0 ? compact.slice(decimalIndex + 1) : '';
  const whole = wholeRaw.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fractionRaw)) {
    throw new InvalidApplePayCaptureError('amountRaw is not a supported currency amount.');
  }
  const amountMinor = Number(whole) * 100 + Number(fractionRaw.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new InvalidApplePayCaptureError('amountRaw is outside the supported range.');
  }
  return amountMinor;
};

export const parseApplePayCapture = (rawBody: string | undefined, idempotencyKey: string | undefined): ApplePayCaptureInput => {
  if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
    throw new InvalidApplePayCaptureError('A valid Idempotency-Key header is required.');
  }
  let body: JsonObject;
  try {
    const parsed = JSON.parse(rawBody ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as JsonObject;
  } catch {
    throw new InvalidApplePayCaptureError('Request body must be a JSON object.');
  }
  const requestId = requiredText(body, 'requestId', 128);
  if (requestId !== idempotencyKey) {
    throw new InvalidApplePayCaptureError('requestId must match the Idempotency-Key header.');
  }
  const institution = body.institution;
  if (institution !== 'santander_mx') {
    throw new InvalidApplePayCaptureError('institution must be santander_mx.');
  }
  const declaredCurrency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : undefined;
  if (declaredCurrency !== 'MXN' && declaredCurrency !== 'USD') {
    throw new InvalidApplePayCaptureError('currency must be MXN or USD.');
  }
  const occurredAt = requiredText(body, 'occurredAt', 64);
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) throw new InvalidApplePayCaptureError('occurredAt must be an ISO 8601 timestamp.');
  const amountRaw = requiredText(body, 'amountRaw', 64);
  // Currency Amount text sometimes includes a stronger ISO/US$ signal than an older Shortcut
  // whose JSON field is still hardcoded to MXN. Prefer that explicit signal when present.
  const currency = /(?:\bUSD\b|US\$)/i.test(amountRaw)
    ? 'USD' as const
    : /(?:\bMXN\b|MX\$)/i.test(amountRaw)
      ? 'MXN' as const
      : declaredCurrency;
  const nameRaw = typeof body.nameRaw === 'string' && body.nameRaw.trim() ? body.nameRaw.trim().slice(0, 200) : undefined;
  return {
    requestId,
    amountRaw,
    amountMinor: parseCurrencyAmount(amountRaw),
    merchantRaw: requiredText(body, 'merchantRaw', 200),
    cardRaw: requiredText(body, 'cardRaw', 200),
    nameRaw,
    occurredAt: new Date(timestamp).toISOString(),
    institution,
    currency,
  };
};

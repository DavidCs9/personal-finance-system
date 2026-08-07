export class InvalidWealthSnapshotError extends Error {}

export interface CajitaSnapshotInput {
  readonly amountMinor: number;
}

export interface CardLiabilitySnapshotInput {
  readonly amountMinor: number;
}

type JsonObject = Record<string, unknown>;

const parseJsonObject = (rawBody: string | undefined): JsonObject => {
  let body: JsonObject;
  try {
    const parsed = JSON.parse(rawBody ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as JsonObject;
  } catch {
    throw new InvalidWealthSnapshotError('Request body must be a JSON object.');
  }
  if (body.currency !== undefined && body.currency !== 'MXN') {
    throw new InvalidWealthSnapshotError('currency must be MXN when provided.');
  }
  return body;
};

const parsePositiveAmountMinor = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new InvalidWealthSnapshotError('amountMinor must be a positive integer in minor units.');
  }
  return value;
};

const parseNonNegativeAmountMinor = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new InvalidWealthSnapshotError('amountMinor must be a non-negative integer in minor units.');
  }
  return value;
};

export const parseCajitaSnapshot = (rawBody: string | undefined): CajitaSnapshotInput => {
  const body = parseJsonObject(rawBody);
  return { amountMinor: parsePositiveAmountMinor(body.amountMinor) };
};

export const parseCardLiabilitySnapshot = (rawBody: string | undefined): CardLiabilitySnapshotInput => {
  const body = parseJsonObject(rawBody);
  return { amountMinor: parseNonNegativeAmountMinor(body.amountMinor) };
};

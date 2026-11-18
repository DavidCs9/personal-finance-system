import { InvalidWealthSnapshotError } from '@finance/ledger/native-wealth';
export { InvalidWealthSnapshotError };

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

export const parseCashSnapshot = (rawBody: string | undefined, allowsZero: boolean): CajitaSnapshotInput => {
  const body = parseJsonObject(rawBody);
  return { amountMinor: allowsZero ? parseNonNegativeAmountMinor(body.amountMinor) : parsePositiveAmountMinor(body.amountMinor) };
};

export const parseCardLiabilitySnapshot = (rawBody: string | undefined): CardLiabilitySnapshotInput => {
  const body = parseJsonObject(rawBody);
  return { amountMinor: parseNonNegativeAmountMinor(body.amountMinor) };
};

export const parsePayrollClosure = (rawBody: string | undefined, today: string) => {
  const body = parseJsonObject(rawBody);
  const validDay = (day: unknown): day is string => {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000') || day > today) return false;
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
  };
  if (typeof body.payslipUuid !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.payslipUuid)) {
    throw new InvalidWealthSnapshotError('Selecciona una nómina ordinaria del empleador.');
  }
  if (!validDay(body.endedOn) || !validDay(body.fundPaidOn) || body.fundPaidOn < body.endedOn) {
    throw new InvalidWealthSnapshotError('Revisa la fecha de salida y la fecha en que recibiste el fondo.');
  }
  return {
    payslipUuid: body.payslipUuid.toLowerCase(),
    endedOn: body.endedOn,
    fundPaidOn: body.fundPaidOn,
    fundPaidMinor: parsePositiveAmountMinor(body.fundPaidMinor),
  };
};

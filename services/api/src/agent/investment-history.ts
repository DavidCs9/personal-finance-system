import {
  dayKeyInZone,
  FINANCE_TIME_ZONE,
  type WealthAccountId,
  type WealthHolding,
  type WealthSnapshot,
} from '@finance/domain';

export const INVESTMENT_HISTORY_RANGES = [
  'yesterday',
  'this_week',
  'last_7_days',
  'this_month',
  'this_year',
  'all',
  'custom',
] as const;

export type InvestmentHistoryRange = (typeof INVESTMENT_HISTORY_RANGES)[number];
export type InvestmentHistoryGranularity = 'daily' | 'monthly';

export interface InvestmentHistoryQuery {
  readonly range?: InvestmentHistoryRange;
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly symbol?: string;
  readonly granularity?: InvestmentHistoryGranularity;
  readonly limit?: number;
}

export class InvalidInvestmentHistoryQueryError extends Error {}

const validDay = (value: string | undefined): value is string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const shiftDay = (day: string, amount: number): string => {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};

const startOfWeek = (today: string): string => {
  const date = new Date(`${today}T12:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return shiftDay(today, -daysSinceMonday);
};

const resolveRange = (
  query: InvestmentHistoryQuery,
  availableFromDay: string,
  availableToDay: string,
  now: Date,
) => {
  const requested = query.range ?? 'this_week';
  if (!INVESTMENT_HISTORY_RANGES.includes(requested)) {
    throw new InvalidInvestmentHistoryQueryError('Rango de inversión inválido.');
  }
  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  switch (requested) {
    case 'yesterday': {
      const yesterday = shiftDay(today, -1);
      return { requested, fromDay: yesterday, toDay: yesterday };
    }
    case 'this_week':
      return { requested, fromDay: startOfWeek(today), toDay: today };
    case 'last_7_days':
      return { requested, fromDay: shiftDay(today, -6), toDay: today };
    case 'this_month':
      return { requested, fromDay: `${today.slice(0, 7)}-01`, toDay: today };
    case 'this_year':
      return { requested, fromDay: `${today.slice(0, 4)}-01-01`, toDay: today };
    case 'all':
      return { requested, fromDay: availableFromDay, toDay: availableToDay };
    case 'custom': {
      const fromDay = query.fromDay ?? availableFromDay;
      const toDay = query.toDay ?? today;
      if (!validDay(fromDay) || !validDay(toDay)) {
        throw new InvalidInvestmentHistoryQueryError('fromDay y toDay deben usar YYYY-MM-DD.');
      }
      if (fromDay > toDay) {
        throw new InvalidInvestmentHistoryQueryError('fromDay no puede ser posterior a toDay.');
      }
      return { requested, fromDay, toDay };
    }
  }
};

const holdingAt = (snapshot: WealthSnapshot, symbol: string): WealthHolding | undefined =>
  snapshot.holdings.find((holding) => holding.symbol.toUpperCase() === symbol);

const entityPoint = (snapshot: WealthSnapshot, symbol?: string) => {
  const holding = symbol ? holdingAt(snapshot, symbol) : undefined;
  return {
    day: snapshot.day,
    valueMxnMinor: symbol ? holding?.valueMxnMinor ?? 0 : snapshot.totalMxnMinor,
    ...(symbol ? { quantity: holding?.quantity ?? 0, currency: holding?.currency ?? null } : {}),
  };
};

const monthlyCloses = <T extends { readonly day: string }>(points: readonly T[]): readonly T[] => {
  const byMonth = new Map<string, T>();
  for (const point of points) byMonth.set(point.day.slice(0, 7), point);
  return [...byMonth.values()];
};

const holdingChanges = (
  snapshots: readonly WealthSnapshot[],
  start: WealthSnapshot,
  end: WealthSnapshot,
) => {
  const symbols = new Set(
    snapshots.flatMap((snapshot) => snapshot.holdings.map((holding) => holding.symbol.toUpperCase())),
  );
  return [...symbols].map((symbol) => {
    const first = holdingAt(start, symbol);
    const latest = holdingAt(end, symbol);
    const startMxnMinor = first?.valueMxnMinor ?? 0;
    const endMxnMinor = latest?.valueMxnMinor ?? 0;
    const startQuantity = first?.quantity ?? 0;
    const endQuantity = latest?.quantity ?? 0;
    const quantityChanged = startQuantity !== endQuantity;
    const changeMxnMinor = endMxnMinor - startMxnMinor;
    return {
      symbol,
      name: latest?.name ?? first?.name ?? symbol,
      currency: latest?.currency ?? first?.currency ?? null,
      startMxnMinor,
      endMxnMinor,
      changeMxnMinor,
      ...(startMxnMinor > 0 ? { changePercent: (changeMxnMinor / startMxnMinor) * 100 } : {}),
      startQuantity,
      endQuantity,
      quantityChanged,
      valueChangeOnly: quantityChanged || startQuantity === 0,
    };
  }).sort((left, right) => Math.abs(right.changeMxnMinor) - Math.abs(left.changeMxnMinor));
};

export const investmentHistoryFromSnapshots = (
  accountId: WealthAccountId,
  snapshotsInput: readonly WealthSnapshot[],
  query: InvestmentHistoryQuery,
  now: Date = new Date(),
) => {
  if (query.granularity && query.granularity !== 'daily' && query.granularity !== 'monthly') {
    throw new InvalidInvestmentHistoryQueryError('La granularidad debe ser daily o monthly.');
  }
  if (query.limit !== undefined && (!Number.isFinite(query.limit) || query.limit <= 0)) {
    throw new InvalidInvestmentHistoryQueryError('limit debe ser un número positivo.');
  }
  const snapshots = [...snapshotsInput]
    .filter((snapshot) => snapshot.accountId === accountId)
    .sort((left, right) => left.day.localeCompare(right.day) || left.capturedAt.localeCompare(right.capturedAt));
  if (snapshots.length === 0) {
    throw new InvalidInvestmentHistoryQueryError('No hay snapshots para esa cuenta.');
  }

  const symbol = query.symbol?.trim().toUpperCase() || undefined;
  if (symbol && !snapshots.some((snapshot) => holdingAt(snapshot, symbol))) {
    throw new InvalidInvestmentHistoryQueryError(`No hay historial de ${symbol} en ${accountId.toUpperCase()}.`);
  }

  const availableFromDay = snapshots[0]!.day;
  const availableToDay = snapshots[snapshots.length - 1]!.day;
  const range = resolveRange(query, availableFromDay, availableToDay, now);
  const selected = snapshots.filter(
    (snapshot) => snapshot.day >= range.fromDay && snapshot.day <= range.toDay,
  );
  if (selected.length === 0) {
    throw new InvalidInvestmentHistoryQueryError(
      `No hay snapshots entre ${range.fromDay} y ${range.toDay}.`,
    );
  }

  const first = selected[0]!;
  const latest = selected[selected.length - 1]!;
  const firstPoint = entityPoint(first, symbol);
  const latestPoint = entityPoint(latest, symbol);
  const startQuantity = 'quantity' in firstPoint ? firstPoint.quantity : undefined;
  const endQuantity = 'quantity' in latestPoint ? latestPoint.quantity : undefined;
  const quantityChanged = symbol ? startQuantity !== endQuantity : false;
  const changeMxnMinor = latestPoint.valueMxnMinor - firstPoint.valueMxnMinor;
  const allPoints = selected.map((snapshot) => entityPoint(snapshot, symbol));
  const granularity = query.granularity
    ?? (range.requested === 'all' || allPoints.length > 120 ? 'monthly' : 'daily');
  const aggregatedPoints = granularity === 'monthly' ? monthlyCloses(allPoints) : allPoints;
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 120), 1), 366);
  const points = aggregatedPoints.slice(-limit);
  const previousSnapshot = snapshots.filter((snapshot) => snapshot.day < first.day).at(-1);

  return {
    accountId,
    ...(symbol ? { symbol } : {}),
    currency: 'MXN',
    requestedRange: range.requested,
    requestedFromDay: range.fromDay,
    requestedToDay: range.toDay,
    availableFromDay,
    availableToDay,
    snapshotFromDay: first.day,
    snapshotToDay: latest.day,
    summary: {
      startMxnMinor: firstPoint.valueMxnMinor,
      endMxnMinor: latestPoint.valueMxnMinor,
      changeMxnMinor,
      ...(firstPoint.valueMxnMinor > 0
        ? { changePercent: (changeMxnMinor / firstPoint.valueMxnMinor) * 100 }
        : {}),
      ...(symbol ? {
        startQuantity,
        endQuantity,
        quantityChanged,
        valueChangeOnly: quantityChanged || startQuantity === 0,
      } : {}),
    },
    ...(previousSnapshot ? { previousPoint: entityPoint(previousSnapshot, symbol) } : {}),
    granularity,
    points,
    truncated: points.length < aggregatedPoints.length,
    ...(symbol ? {} : { holdings: holdingChanges(selected, first, latest) }),
  };
};

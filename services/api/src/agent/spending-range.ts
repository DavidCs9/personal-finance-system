import {
  addCalendarMonths,
  countsTowardMonthSpend,
  dayKeyInZone,
  daysInCalendarMonth,
  eventMonthKey,
  FINANCE_TIME_ZONE,
  isValidMonth,
  personalSpendAmountMinor,
  type CategorizedSpendEvent,
} from '@finance/domain';

export const SPENDING_RANGES = [
  'today',
  'yesterday',
  'this_week',
  'last_7_days',
  'this_month',
  'this_year',
  'custom',
] as const;

export type SpendingRange = (typeof SPENDING_RANGES)[number];

export interface SpendingRangeQuery {
  /** Backwards-compatible full calendar month query. */
  readonly month?: string;
  readonly range?: SpendingRange;
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly categoryId?: string;
  readonly tag?: string;
  readonly limit?: number;
}

export class InvalidSpendingRangeQueryError extends Error {}

export interface ResolvedSpendingRange {
  readonly requestedRange: SpendingRange | 'month';
  readonly fromDay: string;
  readonly toDay: string;
  readonly months: readonly string[];
}

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

const lastDayOfMonth = (month: string): string =>
  `${month}-${String(daysInCalendarMonth(month)).padStart(2, '0')}`;

const monthsBetween = (fromDay: string, toDay: string): readonly string[] => {
  const first = fromDay.slice(0, 7);
  const last = toDay.slice(0, 7);
  const months: string[] = [];
  for (let month = first; month <= last; month = addCalendarMonths(month, 1)) {
    months.push(month);
  }
  return months;
};

const ensureBoundedRange = (fromDay: string, toDay: string): void => {
  const from = Date.parse(`${fromDay}T12:00:00.000Z`);
  const to = Date.parse(`${toDay}T12:00:00.000Z`);
  const calendarDays = Math.floor((to - from) / 86_400_000) + 1;
  if (calendarDays > 366) {
    throw new InvalidSpendingRangeQueryError('El rango de gasto no puede exceder 366 días.');
  }
};

export const resolveSpendingRange = (
  query: SpendingRangeQuery,
  now: Date = new Date(),
): ResolvedSpendingRange => {
  if (query.month !== undefined) {
    if (!isValidMonth(query.month)) {
      throw new InvalidSpendingRangeQueryError('Mes inválido (YYYY-MM).');
    }
    if (query.range !== undefined || query.fromDay !== undefined || query.toDay !== undefined) {
      throw new InvalidSpendingRangeQueryError('Usa month o range, no ambos.');
    }
    const fromDay = `${query.month}-01`;
    const toDay = lastDayOfMonth(query.month);
    return { requestedRange: 'month', fromDay, toDay, months: [query.month] };
  }

  const requestedRange = query.range ?? 'this_month';
  if (!SPENDING_RANGES.includes(requestedRange)) {
    throw new InvalidSpendingRangeQueryError('Rango de gasto inválido.');
  }
  if (requestedRange !== 'custom' && (query.fromDay !== undefined || query.toDay !== undefined)) {
    throw new InvalidSpendingRangeQueryError('fromDay y toDay solo se usan con range=custom.');
  }

  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  let fromDay: string;
  let toDay: string;
  switch (requestedRange) {
    case 'today':
      fromDay = today;
      toDay = today;
      break;
    case 'yesterday':
      fromDay = shiftDay(today, -1);
      toDay = fromDay;
      break;
    case 'this_week':
      fromDay = startOfWeek(today);
      toDay = today;
      break;
    case 'last_7_days':
      fromDay = shiftDay(today, -6);
      toDay = today;
      break;
    case 'this_month':
      fromDay = `${today.slice(0, 7)}-01`;
      toDay = today;
      break;
    case 'this_year':
      fromDay = `${today.slice(0, 4)}-01-01`;
      toDay = today;
      break;
    case 'custom':
      if (!validDay(query.fromDay) || !validDay(query.toDay)) {
        throw new InvalidSpendingRangeQueryError(
          'fromDay y toDay son obligatorios y deben usar YYYY-MM-DD para range=custom.',
        );
      }
      if (query.fromDay > query.toDay) {
        throw new InvalidSpendingRangeQueryError('fromDay no puede ser posterior a toDay.');
      }
      fromDay = query.fromDay;
      toDay = query.toDay;
      break;
  }
  ensureBoundedRange(fromDay, toDay);
  return { requestedRange, fromDay, toDay, months: monthsBetween(fromDay, toDay) };
};

type SpendingMovement = {
  readonly id: string;
  readonly merchantRaw: string;
  readonly categoryId: string | null;
  readonly tags: readonly string[];
  readonly amountMinor: number;
  readonly status: string;
  readonly month: string;
  readonly occurredOn?: string;
  readonly datePrecision: 'day' | 'month';
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
};

const categoryMatches = (event: CategorizedSpendEvent, categoryId: string | undefined): boolean => {
  if (!categoryId) return true;
  if (categoryId === '_uncategorized') return !event.categoryId;
  return event.categoryId === categoryId;
};

const tagMatches = (event: CategorizedSpendEvent, tag: string | undefined): boolean =>
  !tag || event.tags?.includes(tag) === true;

const eventDay = (event: CategorizedSpendEvent): string =>
  dayKeyInZone(new Date(event.occurredAt ?? event.receivedAt), FINANCE_TIME_ZONE);

const fullMonthCovered = (range: ResolvedSpendingRange, month: string): boolean =>
  range.fromDay <= `${month}-01` && range.toDay >= lastDayOfMonth(month);

const wholeSpentMonthCovered = (
  range: ResolvedSpendingRange,
  month: string,
  today: string,
): boolean =>
  fullMonthCovered(range, month)
  || (month === today.slice(0, 7) && range.fromDay <= `${month}-01` && range.toDay >= today);

const monthOverlaps = (range: ResolvedSpendingRange, month: string): boolean =>
  range.fromDay <= lastDayOfMonth(month) && range.toDay >= `${month}-01`;

export const spendingRangeFromEvents = (
  events: readonly CategorizedSpendEvent[],
  query: SpendingRangeQuery,
  now: Date = new Date(),
) => {
  if (query.limit !== undefined && (!Number.isFinite(query.limit) || query.limit <= 0)) {
    throw new InvalidSpendingRangeQueryError('limit debe ser un número positivo.');
  }
  const range = resolveSpendingRange(query, now);
  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  const movements: SpendingMovement[] = [];
  let excludedMonthOnlySpentMinor = 0;
  let excludedMonthOnlyMovementCount = 0;

  for (const event of events) {
    if (!countsTowardMonthSpend(event.status)
      || !categoryMatches(event, query.categoryId)
      || !tagMatches(event, query.tag)) continue;

    if (!event.msi) {
      const occurredOn = eventDay(event);
      if (occurredOn < range.fromDay || occurredOn > range.toDay) continue;
      movements.push({
        id: event.id,
        merchantRaw: event.merchantRaw,
        categoryId: event.categoryId ?? null,
        tags: event.tags ?? [],
        amountMinor: personalSpendAmountMinor(event),
        status: event.status,
        month: occurredOn.slice(0, 7),
        occurredOn,
        datePrecision: 'day',
      });
      continue;
    }

    const purchaseDay = eventDay(event);
    const purchaseMonth = eventMonthKey(event);
    for (const installment of event.msi.installments) {
      if (installment.status !== 'spent' || !monthOverlaps(range, installment.month)) continue;
      const evidenceDay = validDay(installment.occurredOn) ? installment.occurredOn : undefined;
      const occurredOn = evidenceDay ?? (purchaseMonth === installment.month ? purchaseDay : undefined);
      if (occurredOn && (occurredOn < range.fromDay || occurredOn > range.toDay)) continue;
      if (!occurredOn && !wholeSpentMonthCovered(range, installment.month, today)) {
        excludedMonthOnlySpentMinor += installment.amountMinor;
        excludedMonthOnlyMovementCount += 1;
        continue;
      }
      movements.push({
        id: event.id,
        merchantRaw: event.merchantRaw,
        categoryId: event.categoryId ?? null,
        tags: event.tags ?? [],
        amountMinor: installment.amountMinor,
        status: event.status,
        month: installment.month,
        ...(occurredOn ? { occurredOn } : {}),
        datePrecision: occurredOn ? 'day' : 'month',
        installmentIndex: installment.index,
        installmentMonths: event.msi.months,
      });
    }
  }

  movements.sort((left, right) => {
    const leftDay = left.occurredOn ?? `${left.month}-00`;
    const rightDay = right.occurredOn ?? `${right.month}-00`;
    return rightDay.localeCompare(leftDay) || right.amountMinor - left.amountMinor;
  });
  const totalSpentMinor = movements.reduce((sum, movement) => sum + movement.amountMinor, 0);
  const uncertainMinor = movements
    .filter((movement) => movement.status === 'needs_review')
    .reduce((sum, movement) => sum + movement.amountMinor, 0);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 50);

  return {
    currency: 'MXN',
    requestedRange: range.requestedRange,
    fromDay: range.fromDay,
    toDay: range.toDay,
    ...(query.month ? { month: query.month } : {}),
    totalSpentMinor,
    uncertainMinor,
    movementCount: movements.length,
    excludedMonthOnlySpentMinor,
    excludedMonthOnlyMovementCount,
    complete: excludedMonthOnlyMovementCount === 0,
    movements: movements.slice(0, limit),
    truncated: movements.length > limit,
  };
};

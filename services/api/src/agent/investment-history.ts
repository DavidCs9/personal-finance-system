import {
  dayKeyInZone,
  FINANCE_TIME_ZONE,
  type WealthAccountId,
  type WealthHolding,
  type WealthSnapshot,
} from '@finance/domain';

export const INVESTMENT_HISTORY_RANGES = [
  'today',
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
export type InvestmentHistoryAccountId = WealthAccountId | 'all';
type InvestmentHistorySnapshot = Omit<WealthSnapshot, 'accountId'> & {
  readonly accountId: InvestmentHistoryAccountId;
  readonly components?: readonly {
    readonly accountId: WealthAccountId;
    readonly snapshotDay: string;
    readonly capturedAt: string;
    readonly valueMxnMinor: number;
  }[];
  readonly mixedAsOf?: boolean;
  readonly portfolioComplete?: boolean;
  readonly missingAccountIds?: readonly WealthAccountId[];
};

export interface InvestmentHistoryQuery {
  readonly range?: InvestmentHistoryRange;
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly asOfDay?: string;
  readonly symbol?: string;
  readonly holdingId?: string;
  readonly granularity?: InvestmentHistoryGranularity;
  readonly limit?: number;
}

export class InvalidInvestmentHistoryQueryError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_query' | 'no_data' | 'ambiguous' = 'invalid_query',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
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

const resolveRange = (
  query: InvestmentHistoryQuery,
  availableFromDay: string,
  availableToDay: string,
  now: Date,
) => {
  const requested = query.range ?? (query.fromDay || query.toDay ? 'custom' : 'all');
  if (!INVESTMENT_HISTORY_RANGES.includes(requested)) {
    throw new InvalidInvestmentHistoryQueryError('Rango de inversión inválido.');
  }
  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  switch (requested) {
    case 'today':
      return { requested, fromDay: today, toDay: today };
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

const holdingAt = (
  snapshot: InvestmentHistorySnapshot,
  symbol: string,
  holdingId?: string,
): WealthHolding | undefined => holdingId
  ? snapshot.holdings.find((holding) => holding.id === holdingId)
  : snapshot.holdings.find((holding) => holding.symbol.toUpperCase() === symbol);

const entityPoint = (snapshot: InvestmentHistorySnapshot, symbol?: string, holdingId?: string) => {
  const holding = symbol ? holdingAt(snapshot, symbol, holdingId) : undefined;
  const quantity = holding?.quantity ?? 0;
  return {
    day: snapshot.day,
    valueMxnMinor: symbol ? holding?.valueMxnMinor ?? 0 : snapshot.totalMxnMinor,
    ...(symbol ? { held: Boolean(holding) } : {}),
    ...(!symbol && snapshot.components ? {
      components: snapshot.components,
      mixedAsOf: snapshot.mixedAsOf ?? false,
    } : {}),
    ...(symbol ? {
      quantity,
      currency: holding?.currency ?? null,
      unitPriceMxnMinor: holding && Math.abs(quantity) > 0
        ? Math.round(holding.valueMxnMinor / Math.abs(quantity))
        : null,
    } : {}),
  };
};

const monthlyCloses = <T extends { readonly day: string }>(points: readonly T[]): readonly T[] => {
  const byMonth = new Map<string, T>();
  for (const point of points) byMonth.set(point.day.slice(0, 7), point);
  return [...byMonth.values()];
};

/**
 * Produces an as-of portfolio series: on a day where only one provider synced,
 * retain the latest known value from the other provider instead of treating it
 * as zero. A point is emitted only once every available investment account has
 * an initial snapshot, avoiding an artificial gain when a new account appears.
 */
export const portfolioSnapshotsFromAccounts = (
  snapshotsInput: readonly WealthSnapshot[],
  expectedAccountIds: readonly WealthAccountId[] = ['bitso', 'ibkr'],
): readonly InvestmentHistorySnapshot[] => {
  if (snapshotsInput.length === 0) return [];

  const byDay = new Map<string, Map<WealthAccountId, WealthSnapshot>>();
  for (const snapshot of snapshotsInput) {
    const forDay = byDay.get(snapshot.day) ?? new Map<WealthAccountId, WealthSnapshot>();
    const previous = forDay.get(snapshot.accountId);
    if (!previous || previous.capturedAt.localeCompare(snapshot.capturedAt) <= 0) {
      forDay.set(snapshot.accountId, snapshot);
    }
    byDay.set(snapshot.day, forDay);
  }

  const latestByAccount = new Map<WealthAccountId, WealthSnapshot>();
  const portfolio: InvestmentHistorySnapshot[] = [];
  for (const day of [...byDay.keys()].sort()) {
    for (const [accountId, snapshot] of byDay.get(day)!) latestByAccount.set(accountId, snapshot);
    const accountSnapshots = expectedAccountIds.flatMap((accountId) => {
      const snapshot = latestByAccount.get(accountId);
      return snapshot ? [snapshot] : [];
    });
    const missingAccountIds = expectedAccountIds.filter((accountId) => !latestByAccount.has(accountId));
    portfolio.push({
      accountId: 'all',
      day,
      capturedAt: accountSnapshots.map((snapshot) => snapshot.capturedAt).sort().at(-1)!,
      source: 'api',
      currency: 'MXN',
      totalMxnMinor: accountSnapshots.reduce((sum, snapshot) => sum + snapshot.totalMxnMinor, 0),
      holdings: accountSnapshots.flatMap((snapshot) => snapshot.holdings),
      components: accountSnapshots.map((snapshot) => ({
        accountId: snapshot.accountId,
        snapshotDay: snapshot.day,
        capturedAt: snapshot.capturedAt,
        valueMxnMinor: snapshot.totalMxnMinor,
      })),
      mixedAsOf: accountSnapshots.some((snapshot) => snapshot.day !== day),
      portfolioComplete: missingAccountIds.length === 0,
      missingAccountIds,
    });
  }
  return portfolio;
};

const holdingChanges = (
  snapshots: readonly InvestmentHistorySnapshot[],
  start: InvestmentHistorySnapshot,
  end: InvestmentHistorySnapshot,
) => {
  const holdingIds = new Set(
    snapshots.flatMap((snapshot) => snapshot.holdings.map((holding) => holding.id)),
  );
  return [...holdingIds].map((holdingId) => {
    const first = start.holdings.find((holding) => holding.id === holdingId);
    const latest = end.holdings.find((holding) => holding.id === holdingId);
    const symbol = latest?.symbol ?? first?.symbol ?? holdingId;
    const startMxnMinor = first?.valueMxnMinor ?? 0;
    const endMxnMinor = latest?.valueMxnMinor ?? 0;
    const startQuantity = first?.quantity ?? 0;
    const endQuantity = latest?.quantity ?? 0;
    const observedQuantities = snapshots.map((snapshot) =>
      snapshot.holdings.find((holding) => holding.id === holdingId)?.quantity ?? 0,
    );
    const quantityChanged = observedQuantities.some((quantity) => quantity !== observedQuantities[0]);
    const changeMxnMinor = endMxnMinor - startMxnMinor;
    return {
      holdingId,
      ...(/^bitso:/.test(holdingId) ? { accountId: 'bitso' as const } : {}),
      ...(/^ibkr:/.test(holdingId) ? { accountId: 'ibkr' as const } : {}),
      symbol,
      name: latest?.name ?? first?.name ?? symbol,
      currency: latest?.currency ?? first?.currency ?? null,
      startMxnMinor,
      endMxnMinor,
      changeMxnMinor,
      ...(startMxnMinor > 0 ? { valueChangePercent: (changeMxnMinor / startMxnMinor) * 100 } : {}),
      startQuantity,
      endQuantity,
      quantityChanged,
      valueChangeOnly: true,
      cashFlowAdjusted: false,
      includesFx: true,
    };
  }).sort((left, right) => Math.abs(right.changeMxnMinor) - Math.abs(left.changeMxnMinor));
};

export const investmentHistoryFromSnapshots = (
  accountId: InvestmentHistoryAccountId,
  snapshotsInput: readonly InvestmentHistorySnapshot[],
  query: InvestmentHistoryQuery,
  now: Date = new Date(),
) => {
  if (query.granularity && query.granularity !== 'daily' && query.granularity !== 'monthly') {
    throw new InvalidInvestmentHistoryQueryError('La granularidad debe ser daily o monthly.');
  }
  if (
    query.limit !== undefined
    && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 366)
  ) {
    throw new InvalidInvestmentHistoryQueryError('limit debe ser un entero entre 1 y 366.');
  }
  if (query.asOfDay !== undefined && (query.range || query.fromDay || query.toDay)) {
    throw new InvalidInvestmentHistoryQueryError('asOfDay no se puede combinar con range, fromDay o toDay.');
  }
  const snapshots = [...snapshotsInput]
    .filter((snapshot) => accountId === 'all' || snapshot.accountId === accountId)
    .sort((left, right) => left.day.localeCompare(right.day) || left.capturedAt.localeCompare(right.capturedAt));
  if (snapshots.length === 0) {
    throw new InvalidInvestmentHistoryQueryError('No hay snapshots para esa cuenta.', 'no_data');
  }

  const requestedHoldingId = query.holdingId?.trim() || undefined;
  const holdingForId = requestedHoldingId
    ? snapshots.flatMap((snapshot) => snapshot.holdings)
      .find((holding) => holding.id === requestedHoldingId)
    : undefined;
  if (requestedHoldingId && !holdingForId) {
    throw new InvalidInvestmentHistoryQueryError(
      `No hay historial de la posición ${requestedHoldingId} en ${accountId.toUpperCase()}.`,
      'no_data',
    );
  }
  const requestedSymbol = query.symbol?.trim().toUpperCase() || undefined;
  if (requestedSymbol && holdingForId && holdingForId.symbol.toUpperCase() !== requestedSymbol) {
    throw new InvalidInvestmentHistoryQueryError(
      `holdingId ${requestedHoldingId} no corresponde al símbolo ${requestedSymbol}.`,
    );
  }
  const symbol = requestedSymbol ?? holdingForId?.symbol.toUpperCase();
  if (symbol && !snapshots.some((snapshot) => holdingAt(snapshot, symbol))) {
    throw new InvalidInvestmentHistoryQueryError(
      `No hay historial de ${symbol} en ${accountId.toUpperCase()}.`,
      'no_data',
    );
  }
  if (symbol && !requestedHoldingId) {
    const holdingIds = new Set(snapshots.flatMap((snapshot) => snapshot.holdings
      .filter((holding) => holding.symbol.toUpperCase() === symbol)
      .map((holding) => holding.id)));
    if (holdingIds.size > 1) {
      throw new InvalidInvestmentHistoryQueryError(
        `${symbol} identifica más de una posición en ${accountId.toUpperCase()}; especifica la cuenta o posición.`,
        'ambiguous',
        { candidateHoldingIds: [...holdingIds] },
      );
    }
  }

  const availableFromDay = snapshots[0]!.day;
  const availableToDay = snapshots[snapshots.length - 1]!.day;
  const asOfDay = query.asOfDay;
  if (asOfDay !== undefined && !validDay(asOfDay)) {
    throw new InvalidInvestmentHistoryQueryError('asOfDay debe usar YYYY-MM-DD.');
  }
  const range = asOfDay
    ? { requested: 'as_of' as const, fromDay: asOfDay, toDay: asOfDay }
    : resolveRange(query, availableFromDay, availableToDay, now);
  const selected = asOfDay
    ? snapshots.filter((snapshot) => snapshot.day <= asOfDay).slice(-1)
    : snapshots.filter((snapshot) => snapshot.day >= range.fromDay && snapshot.day <= range.toDay);
  if (selected.length === 0) {
    throw new InvalidInvestmentHistoryQueryError(
      `No hay snapshots entre ${range.fromDay} y ${range.toDay}.`,
      'no_data',
      { availableFromDay, availableToDay, requestedFromDay: range.fromDay, requestedToDay: range.toDay },
    );
  }

  const completeSelected = accountId === 'all'
    ? selected.filter((snapshot) => snapshot.portfolioComplete !== false)
    : selected;
  const calculationSnapshots = completeSelected.length > 0 ? completeSelected : selected;
  const first = calculationSnapshots[0]!;
  const latest = calculationSnapshots[calculationSnapshots.length - 1]!;
  const firstPoint = entityPoint(first, symbol, requestedHoldingId);
  const latestPoint = entityPoint(latest, symbol, requestedHoldingId);
  const startQuantity = 'quantity' in firstPoint ? firstPoint.quantity : undefined;
  const endQuantity = 'quantity' in latestPoint ? latestPoint.quantity : undefined;
  const observedQuantities = symbol
    ? calculationSnapshots.map((snapshot) => holdingAt(snapshot, symbol, requestedHoldingId)?.quantity ?? 0)
    : [];
  const quantityChanged = symbol
    ? observedQuantities.some((quantity) => quantity !== observedQuantities[0])
    : false;
  const holdingIds = new Set(calculationSnapshots.flatMap(
    (snapshot) => snapshot.holdings.map((holding) => holding.id),
  ));
  const holdingsChangedWithinRange = [...holdingIds].some((holdingId) => {
    const quantities = calculationSnapshots.map((snapshot) =>
      snapshot.holdings.find((holding) => holding.id === holdingId)?.quantity ?? 0,
    );
    return quantities.some((quantity) => quantity !== quantities[0]);
  });
  const changeMxnMinor = latestPoint.valueMxnMinor - firstPoint.valueMxnMinor;
  const allPoints = calculationSnapshots.map((snapshot) => entityPoint(snapshot, symbol, requestedHoldingId));
  const granularity = query.granularity
    ?? (range.requested === 'all' || allPoints.length > 120 ? 'monthly' : 'daily');
  const aggregatedPoints = granularity === 'monthly' ? monthlyCloses(allPoints) : allPoints;
  const limit = query.limit ?? 120;
  const points = aggregatedPoints.slice(-limit);
  const extremaPoints = accountId === 'all' && completeSelected.length === 0
    ? []
    : symbol
      ? allPoints.filter((point) => point.held)
      : allPoints;
  const minimumPoint = extremaPoints.length > 0
    ? extremaPoints.reduce((minimum, point) =>
      point.valueMxnMinor < minimum.valueMxnMinor ? point : minimum,
    )
    : undefined;
  const maximumPoint = extremaPoints.length > 0
    ? extremaPoints.reduce((maximum, point) =>
      point.valueMxnMinor > maximum.valueMxnMinor ? point : maximum,
    )
    : undefined;
  const previousSnapshot = snapshots.filter((snapshot) => snapshot.day < first.day).at(-1);
  const previousPoint = previousSnapshot ? entityPoint(previousSnapshot, symbol, requestedHoldingId) : undefined;
  const previousChangeMxnMinor = previousPoint
    ? latestPoint.valueMxnMinor - previousPoint.valueMxnMinor
    : undefined;
  const unitPricePoints = symbol
    ? allPoints.filter((point) => point.unitPriceMxnMinor !== null)
    : [];
  const minimumUnitPricePoint = unitPricePoints.length > 0
    ? unitPricePoints.reduce((minimum, point) =>
      point.unitPriceMxnMinor! < minimum.unitPriceMxnMinor! ? point : minimum,
    )
    : undefined;
  const maximumUnitPricePoint = unitPricePoints.length > 0
    ? unitPricePoints.reduce((maximum, point) =>
      point.unitPriceMxnMinor! > maximum.unitPriceMxnMinor! ? point : maximum,
    )
    : undefined;
  const startUnitPrice = 'unitPriceMxnMinor' in firstPoint ? firstPoint.unitPriceMxnMinor ?? null : null;
  const endUnitPrice = 'unitPriceMxnMinor' in latestPoint ? latestPoint.unitPriceMxnMinor ?? null : null;
  const lifecyclePoints = symbol
    ? snapshots.map((snapshot) => entityPoint(snapshot, symbol, requestedHoldingId)).filter((point) => point.held)
    : [];
  const periodStartPoint = previousPoint ?? firstPoint;
  const periodChangeMxnMinor = latestPoint.valueMxnMinor - periodStartPoint.valueMxnMinor;
  const periodSnapshots = previousSnapshot
    ? [previousSnapshot, ...calculationSnapshots]
    : calculationSnapshots;
  const periodQuantities = symbol
    ? periodSnapshots.map((snapshot) => holdingAt(snapshot, symbol, requestedHoldingId)?.quantity ?? 0)
    : [];
  const periodQuantityChanged = symbol
    ? periodQuantities.some((quantity) => quantity !== periodQuantities[0])
    : false;
  const periodHoldingIds = new Set(periodSnapshots.flatMap(
    (snapshot) => snapshot.holdings.map((holding) => holding.id),
  ));
  const holdingsChangedWithinPeriod = [...periodHoldingIds].some((holdingId) => {
    const quantities = periodSnapshots.map((snapshot) =>
      snapshot.holdings.find((holding) => holding.id === holdingId)?.quantity ?? 0,
    );
    return quantities.some((quantity) => quantity !== quantities[0]);
  });
  const partialPointCount = accountId === 'all'
    ? selected.filter((snapshot) => snapshot.portfolioComplete === false).length
    : 0;
  const hasMixedAsOfPoints = accountId === 'all'
    && calculationSnapshots.some((snapshot) => snapshot.mixedAsOf === true);
  const periodComparablePortfolio = accountId !== 'all'
    || periodSnapshots.every((snapshot) => snapshot.portfolioComplete !== false);

  return {
    ok: true,
    status: partialPointCount > 0 ? 'partial' : 'ok',
    accountId,
    scope: 'market_investments',
    ...(symbol ? { symbol } : {}),
    ...(requestedHoldingId ? { holdingId: requestedHoldingId } : {}),
    currency: 'MXN',
    requestedRange: range.requested,
    requestedFromDay: range.fromDay,
    requestedToDay: range.toDay,
    availableFromDay,
    availableToDay,
    snapshotFromDay: first.day,
    snapshotToDay: latest.day,
    summary: {
      changeBasis: 'observed_value_mxn',
      startMxnMinor: firstPoint.valueMxnMinor,
      endMxnMinor: latestPoint.valueMxnMinor,
      changeMxnMinor,
      ...(firstPoint.valueMxnMinor > 0
        ? { valueChangePercent: (changeMxnMinor / firstPoint.valueMxnMinor) * 100 }
        : {}),
      valueChangeOnly: true,
      cashFlowAdjusted: false,
      includesFx: true,
      holdingsChangedWithinRange,
      ...(symbol ? {
        startQuantity,
        endQuantity,
        quantityChanged,
        valueChangeOnly: true,
        ...(startUnitPrice !== null && endUnitPrice !== null ? {
          unitPriceStartMxnMinor: startUnitPrice,
          unitPriceEndMxnMinor: endUnitPrice,
          unitPriceChangeMxnMinor: endUnitPrice - startUnitPrice,
          ...(startUnitPrice > 0
            ? { unitPriceChangePercent: ((endUnitPrice - startUnitPrice) / startUnitPrice) * 100 }
            : {}),
        } : {}),
      } : {}),
    },
    ...(previousPoint ? {
      previousPoint,
      previousChange: {
        fromDay: previousPoint.day,
        toDay: latestPoint.day,
        startMxnMinor: previousPoint.valueMxnMinor,
        endMxnMinor: latestPoint.valueMxnMinor,
        changeMxnMinor: previousChangeMxnMinor!,
        ...(previousPoint.valueMxnMinor > 0
          ? { valueChangePercent: (previousChangeMxnMinor! / previousPoint.valueMxnMinor) * 100 }
          : {}),
      },
    } : {}),
    periodChange: {
      fromDay: periodStartPoint.day,
      toDay: latestPoint.day,
      startMxnMinor: periodStartPoint.valueMxnMinor,
      endMxnMinor: latestPoint.valueMxnMinor,
      changeMxnMinor: periodChangeMxnMinor,
      ...(periodStartPoint.valueMxnMinor > 0
        ? { valueChangePercent: (periodChangeMxnMinor / periodStartPoint.valueMxnMinor) * 100 }
        : {}),
      basis: previousPoint ? 'previous_observation_to_range_end' : 'range_start_to_range_end',
      valueChangeOnly: true,
      cashFlowAdjusted: false,
      includesFx: true,
      holdingsChangedWithinPeriod,
      ...(symbol ? { quantityChanged: periodQuantityChanged } : {}),
      ...(accountId === 'all' ? { comparablePortfolio: periodComparablePortfolio } : {}),
    },
    granularity,
    points,
    extremaBasis: 'daily_observed_values',
    ...(minimumPoint ? { minimumPoint } : {}),
    ...(maximumPoint ? { maximumPoint } : {}),
    ...(minimumUnitPricePoint ? { minimumUnitPricePoint } : {}),
    ...(maximumUnitPricePoint ? { maximumUnitPricePoint } : {}),
    truncated: points.length < aggregatedPoints.length,
    ...(accountId === 'all' ? {
      comparablePortfolio: completeSelected.length > 0,
      completePointCount: completeSelected.length,
      partialPointCount,
      hasMixedAsOfPoints,
      summaryUsesMixedAsOf: first.mixedAsOf === true || latest.mixedAsOf === true,
      extremaUseMixedAsOf: extremaPoints.some((point) => point.mixedAsOf === true),
      missingAccountIdsInRange: [...new Set(selected.flatMap(
        (snapshot) => snapshot.missingAccountIds ?? [],
      ))],
    } : {}),
    ...(symbol ? {
      lifecycle: {
        firstHeldDay: lifecyclePoints[0]?.day ?? null,
        lastHeldDay: lifecyclePoints.at(-1)?.day ?? null,
        heldAtRangeStart: Boolean(firstPoint.held),
        heldAtRangeEnd: Boolean(latestPoint.held),
        zeroValuePeriodsExcludedFromExtrema: allPoints.length - extremaPoints.length,
      },
    } : {}),
    limitations: [
      'observed_values_not_cash_flow_adjusted',
      'mxn_changes_include_fx',
      'no_cost_basis_dividends_or_realized_return',
      'ibkr_non_usd_positions_may_be_excluded',
    ],
    ...(symbol ? {} : { holdings: holdingChanges(calculationSnapshots, first, latest) }),
  };
};

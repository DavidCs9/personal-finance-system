import { describe, expect, it } from 'vitest';
import type { WealthSnapshot } from '@finance/domain';
import {
  investmentHistoryFromSnapshots,
  InvalidInvestmentHistoryQueryError,
  portfolioSnapshotsFromAccounts,
} from '../src/agent/investment-history.js';

const snapshot = (
  day: string,
  holdings: readonly { symbol: string; valueMxnMinor: number; quantity: number }[],
): WealthSnapshot => ({
  accountId: 'ibkr',
  day,
  capturedAt: `${day}T12:00:00.000Z`,
  source: 'flex',
  currency: 'MXN',
  totalMxnMinor: holdings.reduce((sum, holding) => sum + holding.valueMxnMinor, 0),
  holdings: holdings.map((holding) => ({
    id: `ibkr:${holding.symbol.toLowerCase()}`,
    symbol: holding.symbol,
    name: holding.symbol,
    quantity: holding.quantity,
    currency: 'USD',
    valueNativeMinor: holding.valueMxnMinor,
    valueMxnMinor: holding.valueMxnMinor,
  })),
});

describe('investmentHistoryFromSnapshots', () => {
  const sunday = new Date('2026-08-09T18:00:00.000Z');
  const snapshots = [
    snapshot('2026-08-02', [{ symbol: 'VOO', valueMxnMinor: 9_000, quantity: 2 }]),
    snapshot('2026-08-03', [{ symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 }]),
    snapshot('2026-08-08', [
      { symbol: 'VOO', valueMxnMinor: 11_500, quantity: 2 },
      { symbol: 'MSFT', valueMxnMinor: 4_000, quantity: 1 },
    ]),
  ];

  it('answers a symbol query for this week and provides the prior point', () => {
    expect(investmentHistoryFromSnapshots('ibkr', snapshots, {
      symbol: 'voo', range: 'this_week',
    }, sunday)).toMatchObject({
      accountId: 'ibkr', symbol: 'VOO', snapshotFromDay: '2026-08-03', snapshotToDay: '2026-08-08',
      summary: { changeMxnMinor: 1_500, valueChangePercent: 15, quantityChanged: false, valueChangeOnly: true },
      previousPoint: { day: '2026-08-02', valueMxnMinor: 9_000 },
      periodChange: { fromDay: '2026-08-02', toDay: '2026-08-08', changeMxnMinor: 2_500 },
      granularity: 'daily', truncated: false,
    });
  });

  it('returns one-day history with a previous comparison point', () => {
    expect(investmentHistoryFromSnapshots('ibkr', snapshots, {
      symbol: 'VOO', range: 'yesterday',
    }, sunday)).toMatchObject({
      snapshotFromDay: '2026-08-08', snapshotToDay: '2026-08-08',
      summary: { startMxnMinor: 11_500, endMxnMinor: 11_500 },
      previousPoint: { day: '2026-08-03', valueMxnMinor: 10_000 },
    });
  });

  it('returns account history and per-holding changes', () => {
    const result = investmentHistoryFromSnapshots('ibkr', snapshots, { range: 'all' }, sunday);
    expect(result).toMatchObject({
      summary: { startMxnMinor: 9_000, endMxnMinor: 15_500, changeMxnMinor: 6_500 },
      granularity: 'monthly',
    });
    expect(result.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'VOO', changeMxnMinor: 2_500, valueChangeOnly: true }),
      expect.objectContaining({ symbol: 'MSFT', changeMxnMinor: 4_000, valueChangeOnly: true }),
    ]));
  });

  it('marks quantity changes as value-only changes', () => {
    const result = investmentHistoryFromSnapshots('ibkr', [
      snapshot('2026-08-03', [{ symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 }]),
      snapshot('2026-08-08', [{ symbol: 'VOO', valueMxnMinor: 16_000, quantity: 3 }]),
    ], { symbol: 'VOO', range: 'this_week' }, sunday);
    expect(result.summary).toMatchObject({ quantityChanged: true, valueChangeOnly: true });
  });

  it('detects an intraperiod buy and sell even when endpoint quantity is unchanged', () => {
    const result = investmentHistoryFromSnapshots('ibkr', [
      snapshot('2026-08-03', [{ symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 }]),
      snapshot('2026-08-04', [{ symbol: 'VOO', valueMxnMinor: 15_000, quantity: 3 }]),
      snapshot('2026-08-08', [{ symbol: 'VOO', valueMxnMinor: 11_000, quantity: 2 }]),
    ], { symbol: 'VOO', range: 'this_week' }, sunday);

    expect(result.summary).toMatchObject({
      startQuantity: 2,
      endQuantity: 2,
      quantityChanged: true,
      valueChangeOnly: true,
      unitPriceStartMxnMinor: 5_000,
      unitPriceEndMxnMinor: 5_500,
      unitPriceChangePercent: 10,
      cashFlowAdjusted: false,
      includesFx: true,
    });
  });

  it('detects a quantity change at the range boundary in periodChange', () => {
    const result = investmentHistoryFromSnapshots('ibkr', [
      snapshot('2026-08-02', [{ symbol: 'VOO', valueMxnMinor: 5_000, quantity: 1 }]),
      snapshot('2026-08-08', [{ symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 }]),
    ], { symbol: 'VOO', range: 'yesterday' }, sunday);

    expect(result).toMatchObject({
      summary: { quantityChanged: false, valueChangeOnly: true },
      periodChange: {
        fromDay: '2026-08-02',
        toDay: '2026-08-08',
        changeMxnMinor: 5_000,
        quantityChanged: true,
        holdingsChangedWithinPeriod: true,
        valueChangeOnly: true,
        cashFlowAdjusted: false,
        includesFx: true,
      },
    });
  });

  it('uses all-time by default and excludes periods before or after ownership from symbol extrema', () => {
    const result = investmentHistoryFromSnapshots('ibkr', [
      snapshot('2026-08-01', []),
      snapshot('2026-08-02', [{ symbol: 'VOO', valueMxnMinor: 9_000, quantity: 2 }]),
      snapshot('2026-08-03', [{ symbol: 'VOO', valueMxnMinor: 12_000, quantity: 2 }]),
      snapshot('2026-08-04', []),
    ], { symbol: 'VOO' }, sunday);

    expect(result).toMatchObject({
      requestedRange: 'all',
      minimumPoint: { day: '2026-08-02', valueMxnMinor: 9_000, held: true },
      maximumPoint: { day: '2026-08-03', valueMxnMinor: 12_000, held: true },
      lifecycle: {
        firstHeldDay: '2026-08-02',
        lastHeldDay: '2026-08-03',
        heldAtRangeStart: false,
        heldAtRangeEnd: false,
        zeroValuePeriodsExcludedFromExtrema: 2,
      },
    });
  });

  it('answers point-in-time queries with the latest snapshot known on or before the date', () => {
    expect(investmentHistoryFromSnapshots('ibkr', snapshots, {
      symbol: 'VOO', asOfDay: '2026-08-06',
    }, sunday)).toMatchObject({
      requestedRange: 'as_of',
      requestedFromDay: '2026-08-06',
      requestedToDay: '2026-08-06',
      snapshotFromDay: '2026-08-03',
      snapshotToDay: '2026-08-03',
      summary: { endMxnMinor: 10_000 },
    });
  });

  it('infers a custom range from explicit dates even when range is omitted', () => {
    expect(investmentHistoryFromSnapshots('ibkr', snapshots, {
      fromDay: '2026-08-03', toDay: '2026-08-08',
    }, sunday)).toMatchObject({
      requestedRange: 'custom',
      snapshotFromDay: '2026-08-03',
      snapshotToDay: '2026-08-08',
    });
  });

  it('returns an as-of consolidated portfolio with range minimum and maximum', () => {
    const bitso = (day: string, valueMxnMinor: number) => ({
      ...snapshot(day, [{ symbol: 'SOL', valueMxnMinor, quantity: 1 }]),
      accountId: 'bitso' as const,
      source: 'api' as const,
      holdings: snapshot(day, [{ symbol: 'SOL', valueMxnMinor, quantity: 1 }]).holdings.map((holding) => ({
        ...holding,
        id: holding.id.replace('ibkr:', 'bitso:'),
      })),
    });
    const portfolio = portfolioSnapshotsFromAccounts([
      bitso('2026-08-02', 2_000),
      snapshot('2026-08-03', [{ symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 }]),
      bitso('2026-08-08', 3_000),
    ]);

    expect(investmentHistoryFromSnapshots('all', portfolio, { range: 'all' }, sunday)).toMatchObject({
      accountId: 'all',
      status: 'partial',
      summary: { startMxnMinor: 12_000, endMxnMinor: 13_000, changeMxnMinor: 1_000 },
      minimumPoint: { day: '2026-08-03', valueMxnMinor: 12_000 },
      maximumPoint: { day: '2026-08-08', valueMxnMinor: 13_000 },
      points: [
        expect.objectContaining({ day: '2026-08-08', mixedAsOf: true }),
      ],
      holdings: expect.arrayContaining([
        expect.objectContaining({ accountId: 'bitso', symbol: 'SOL' }),
        expect.objectContaining({ accountId: 'ibkr', symbol: 'VOO' }),
      ]),
      comparablePortfolio: true,
      partialPointCount: 1,
    });
  });

  it('returns pre-coverage global history as partial without incomparable extrema', () => {
    const bitsoOnly = portfolioSnapshotsFromAccounts([
      {
        ...snapshot('2026-01-02', [{ symbol: 'SOL', valueMxnMinor: 2_000, quantity: 1 }]),
        accountId: 'bitso',
        source: 'api',
      },
      snapshot('2026-08-03', [{ symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 }]),
    ]);
    const result = investmentHistoryFromSnapshots('all', bitsoOnly, {
      range: 'custom', fromDay: '2026-01-01', toDay: '2026-01-31',
    }, sunday);

    expect(result).toMatchObject({
      status: 'partial',
      comparablePortfolio: false,
      completePointCount: 0,
      partialPointCount: 1,
      missingAccountIdsInRange: ['ibkr'],
    });
    expect(result).not.toHaveProperty('minimumPoint');
    expect(result).not.toHaveProperty('maximumPoint');
  });

  it('validates custom dates and output controls', () => {
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      range: 'custom', fromDay: '2026-08-09', toDay: '2026-08-03',
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      range: 'all', limit: 0,
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      range: 'all', limit: 1.5,
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      range: 'all', limit: 367,
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      asOfDay: '2026-08-08', range: 'all',
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
  });

  it('rejects a symbol that identifies multiple positions within one account', () => {
    const duplicate = snapshot('2026-08-08', [
      { symbol: 'VOO', valueMxnMinor: 10_000, quantity: 2 },
      { symbol: 'VOO', valueMxnMinor: 4_000, quantity: 1 },
    ]);
    duplicate.holdings.forEach((holding, index) => {
      (holding as { id: string }).id = `ibkr:conid-${index}`;
    });

    expect(() => investmentHistoryFromSnapshots('ibkr', [duplicate], {
      symbol: 'VOO', range: 'all',
    }, sunday)).toThrow(expect.objectContaining({
      code: 'ambiguous',
      details: { candidateHoldingIds: ['ibkr:conid-0', 'ibkr:conid-1'] },
    }));
    expect(investmentHistoryFromSnapshots('ibkr', [duplicate], {
      symbol: 'VOO', holdingId: 'ibkr:conid-1', range: 'all',
    }, sunday)).toMatchObject({
      symbol: 'VOO',
      holdingId: 'ibkr:conid-1',
      summary: { endMxnMinor: 4_000, endQuantity: 1 },
    });
  });
});

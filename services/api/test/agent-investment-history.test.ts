import { describe, expect, it } from 'vitest';
import type { WealthSnapshot } from '@finance/domain';
import {
  investmentHistoryFromSnapshots,
  InvalidInvestmentHistoryQueryError,
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
      summary: { changeMxnMinor: 1_500, changePercent: 15, quantityChanged: false, valueChangeOnly: false },
      previousPoint: { day: '2026-08-02', valueMxnMinor: 9_000 },
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
      expect.objectContaining({ symbol: 'VOO', changeMxnMinor: 2_500, valueChangeOnly: false }),
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

  it('validates custom dates and output controls', () => {
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      range: 'custom', fromDay: '2026-08-09', toDay: '2026-08-03',
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
    expect(() => investmentHistoryFromSnapshots('ibkr', snapshots, {
      range: 'all', limit: 0,
    }, sunday)).toThrow(InvalidInvestmentHistoryQueryError);
  });
});

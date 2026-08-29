import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WealthSnapshot } from '@finance/domain';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';

const listWealthSnapshotsForAccount = vi.fn();

vi.mock('../src/wealth/service.js', () => ({
  listWealthSnapshotsForAccount,
  getWealthOverview: vi.fn(),
}));

const { investmentHistory } = await import('../src/agent/aggregates.js');
const { runAgentTool } = await import('../src/agent/tools.js');

const snapshot = (
  accountId: 'bitso' | 'ibkr',
  day: string,
  totalMxnMinor: number,
  symbol?: string,
): WealthSnapshot => ({
  accountId,
  day,
  capturedAt: `${day}T12:00:00.000Z`,
  source: accountId === 'bitso' ? 'api' : 'flex',
  currency: 'MXN',
  totalMxnMinor,
  holdings: symbol ? [{
    id: `${accountId}:${symbol.toLowerCase()}`,
    symbol,
    name: symbol,
    quantity: 1,
    currency: accountId === 'bitso' ? symbol : 'USD',
    valueNativeMinor: totalMxnMinor,
    valueMxnMinor: totalMxnMinor,
  }] : [],
});

describe('investmentHistory', () => {
  beforeEach(() => {
    listWealthSnapshotsForAccount.mockReset();
    listWealthSnapshotsForAccount.mockImplementation(async (_owner: string, accountId: string) => {
      if (accountId === 'bitso') {
        return [snapshot('bitso', '2026-08-02', 2_000, 'SOL'), snapshot('bitso', '2026-08-08', 3_000, 'SOL')];
      }
      return [snapshot('ibkr', '2026-08-03', 10_000, 'VOO')];
    });
  });

  it('treats a missing account and the natural-language global alias as a consolidated portfolio', async () => {
    const now = new Date('2026-08-09T18:00:00.000Z');

    await expect(investmentHistory('owner', {}, now)).resolves.toMatchObject({
      accountId: 'all',
      status: 'partial',
      scope: 'market_investments',
      requestedRange: 'all',
      includedAccountIds: ['bitso', 'ibkr'],
      missingAccountIds: [],
      minimumPoint: { day: '2026-08-03', valueMxnMinor: 12_000 },
      maximumPoint: { day: '2026-08-08', valueMxnMinor: 13_000 },
    });
    await expect(investmentHistory('owner', { accountId: 'inversiones' }, now)).resolves.toMatchObject({
      accountId: 'all',
      requestedRange: 'all',
    });
    await expect(investmentHistory('owner', {
      accountId: 'inversiones', symbol: 'VOO', range: 'all',
    }, now)).resolves.toMatchObject({ accountId: 'ibkr', symbol: 'VOO' });
  });

  it('marks a global result as partial when an expected provider has no history', async () => {
    listWealthSnapshotsForAccount.mockImplementation(async (_owner: string, accountId: string) =>
      accountId === 'bitso' ? [snapshot('bitso', '2026-08-08', 3_000, 'SOL')] : [],
    );

    await expect(investmentHistory('owner', {}, new Date('2026-08-09T18:00:00.000Z'))).resolves.toMatchObject({
      status: 'partial',
      includedAccountIds: ['bitso'],
      missingAccountIds: ['ibkr'],
      accountCoverage: [expect.objectContaining({ accountId: 'bitso', latestAgeDays: 1 })],
    });
  });

  it('returns expected query states as data instead of a Gateway failure', async () => {
    await expect(runAgentTool('owner', 'investment_history', {
      accountId: 'broker-inventado',
    })).resolves.toEqual({
      ok: false,
      status: 'invalid',
      reasonCode: 'invalid_account',
      message: 'La cuenta debe ser Bitso o IBKR. Omítela para consultar todas tus inversiones.',
    });

    await expect(runAgentTool('owner', 'investment_history', {
      accountId: 'ibkr', range: 'custom', fromDay: '2025-01-01', toDay: '2025-01-31',
    })).resolves.toMatchObject({
      ok: false,
      status: 'no_data',
      reasonCode: 'no_data',
      details: { availableFromDay: '2026-08-03', availableToDay: '2026-08-03' },
    });

    listWealthSnapshotsForAccount.mockImplementation(async (_owner: string, accountId: string) =>
      [snapshot(accountId as 'bitso' | 'ibkr', '2026-08-08', 3_000, 'USD')],
    );
    await expect(runAgentTool('owner', 'investment_history', {
      symbol: 'USD',
    })).resolves.toMatchObject({
      ok: false,
      status: 'ambiguous',
      reasonCode: 'ambiguous',
      details: { candidateAccountIds: ['bitso', 'ibkr'] },
    });
  });
});

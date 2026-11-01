import { describe, expect, it } from 'vitest';
import { wealthFactsForAgent } from '../src/agent/wealth-facts.js';
import type { WealthBalanceOverview } from '../src/wealth/service.js';

describe('agent wealth facts', () => {
  it('keeps debt totals, exact market subtotal, dates and restricted savings separate from cash', () => {
    const wealth: WealthBalanceOverview = {
      currency: 'MXN', asOfDay: '2026-10-31', totalMxnMinor: 25235801, assetsMxnMinor: 27235801,
      liabilitiesMxnMinor: 2000000, netMxnMinor: 25235801,
      accounts: (['nu_cajita_emergencia', 'fondo_ahorro', 'bitso', 'ibkr'] as const).map((id, index) => ({
        id, name: id, connected: true, institution: 'test', role: 'test', sync: 'test',
        latestSnapshot: { accountId: id, day: '2026-10-22', capturedAt: '2026-10-22T18:00:00Z',
          source: 'manual', currency: 'MXN', totalMxnMinor: [10000000, 9000000, 345678, 7890123][index]!, holdings: [] },
      })),
      liabilities: [{ cardId: 'card', name: 'Card', latestSnapshot: { cardId: 'card', day: '2026-10-22',
        capturedAt: '2026-10-22T18:00:00Z', source: 'manual', currency: 'MXN', totalMxnMinor: 2000000 } }],
    };
    const result = wealthFactsForAgent(wealth, new Date('2026-10-31T18:00:00Z'));
    expect(result).toMatchObject({ scope: 'current_net_worth', asOfDay: '2026-10-31', netMxnMinor: 25235801,
      marketInvestmentsMxnMinor: 8235801, cashAccountMxnMinor: 10000000,
      staleManualAccountIds: ['nu_cajita_emergencia'], staleLiabilityCardIds: ['card'],
      liabilities: [{ latestMxnMinor: 2000000, day: '2026-10-22', ageDays: 9 }] });
    expect(result.accounts.find(account => account.id === 'fondo_ahorro')?.liquidity).toBe('payroll_savings_illiquid_until_december');
    const missing = wealthFactsForAgent({ ...wealth, accounts: wealth.accounts.map(account => account.id === 'bitso'
      ? { ...account, latestSnapshot: null } : account), liabilities: [{ ...wealth.liabilities[0]!, latestSnapshot: null }] });
    expect(missing).toMatchObject({ marketInvestmentsMxnMinor: null, missingAccountIds: ['bitso'],
      missingLiabilityCardIds: ['card'], liabilities: [{ latestMxnMinor: null }] });
  });
});

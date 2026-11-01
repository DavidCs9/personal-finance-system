import { CAJITA_STALE_DAYS, CARD_LIABILITY_STALE_DAYS, wealthSnapshotAgeDays } from '@finance/domain';
import type { WealthBalanceOverview } from '../wealth/service.js';

/** Preserve the canonical totals and supply dates, missing evidence and account meaning alongside them. */
export const wealthFactsForAgent = (wealth: WealthBalanceOverview, now = new Date()) => {
  const accounts = wealth.accounts.map(account => ({
    id: account.id, name: account.name, connected: account.connected,
    latestMxnMinor: account.latestSnapshot?.totalMxnMinor ?? null,
    day: account.latestSnapshot?.day ?? null,
    capturedAt: account.latestSnapshot?.capturedAt ?? null,
    ageDays: account.latestSnapshot ? wealthSnapshotAgeDays(account.latestSnapshot.day, now) : null,
    liquidity: account.id === 'fondo_ahorro' ? 'payroll_savings_illiquid_until_december'
      : account.id === 'nu_cajita_emergencia' ? 'cash' : 'market_investment',
  }));
  const liabilities = wealth.liabilities.map(liability => ({
    cardId: liability.cardId, name: liability.name,
    latestMxnMinor: liability.latestSnapshot?.totalMxnMinor ?? null,
    day: liability.latestSnapshot?.day ?? null,
    capturedAt: liability.latestSnapshot?.capturedAt ?? null,
    ageDays: liability.latestSnapshot ? wealthSnapshotAgeDays(liability.latestSnapshot.day, now) : null,
  }));
  const market = accounts.filter(account => account.id === 'bitso' || account.id === 'ibkr');
  return {
    scope: 'current_net_worth', currency: wealth.currency, asOfDay: wealth.asOfDay,
    netMxnMinor: wealth.netMxnMinor, assetsMxnMinor: wealth.assetsMxnMinor,
    liabilitiesMxnMinor: wealth.liabilitiesMxnMinor,
    marketInvestmentsMxnMinor: market.length === 2 && market.every(account => account.latestMxnMinor !== null)
      ? market.reduce((sum, account) => sum + account.latestMxnMinor!, 0) : null,
    cashAccountMxnMinor: accounts.find(account => account.id === 'nu_cajita_emergencia')?.latestMxnMinor ?? null,
    missingAccountIds: accounts.filter(account => account.latestMxnMinor === null).map(account => account.id),
    missingLiabilityCardIds: liabilities.filter(liability => liability.latestMxnMinor === null).map(liability => liability.cardId),
    staleManualAccountIds: accounts.filter(account => account.id === 'nu_cajita_emergencia'
      && account.ageDays !== null && account.ageDays >= CAJITA_STALE_DAYS).map(account => account.id),
    staleLiabilityCardIds: liabilities.filter(liability => liability.ageDays !== null && liability.ageDays >= CARD_LIABILITY_STALE_DAYS).map(liability => liability.cardId),
    accounts, liabilities,
  };
};

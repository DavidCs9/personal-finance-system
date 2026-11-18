import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BITSO_ACCOUNT_ID, IBKR_ACCOUNT_ID, dayKeyInZone, type WealthSnapshot } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { wealthQueryKey } from "../lib/query-keys";
import { withWealthTotals, type WealthOverview } from "../wealth";
import { demoWealthOverview } from "../wealth-demo";

type MarketAccountId = typeof BITSO_ACCOUNT_ID | typeof IBKR_ACCOUNT_ID;

const withDemoMarketSnapshot = (base: WealthOverview, snapshot: WealthSnapshot, id: MarketAccountId): WealthOverview => {
  const accounts = base.accounts.map(account => account.id === id ? { ...account, connected: true, latestSnapshot: snapshot } : account);
  const accountHistory = [
    ...(base.history.byAccount[id] ?? []).filter(point => point.day !== snapshot.day),
    { day: snapshot.day, totalMxnMinor: snapshot.totalMxnMinor },
  ].sort((left, right) => left.day.localeCompare(right.day));
  const byAccount = { ...base.history.byAccount, [id]: accountHistory };
  const allByDay = new Map<string, number>();
  for (const account of accounts) {
    for (const point of byAccount[account.id] ?? []) {
      allByDay.set(point.day, (allByDay.get(point.day) ?? 0) + point.totalMxnMinor);
    }
  }
  return withWealthTotals({
    accounts, liabilities: base.liabilities,
    history: {
      byAccount,
      all: [...allByDay.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([day, totalMxnMinor]) => ({ day, totalMxnMinor })),
    },
  });
};

export function useMarketWealthSync(id: MarketAccountId, idToken: string, demoMode: boolean, now: Date) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!demoMode) return id === BITSO_ACCOUNT_ID ? ledgerApi.syncBitso(idToken) : ledgerApi.syncIbkr(idToken);
      const snapshot: WealthSnapshot = {
        accountId: id, day: dayKeyInZone(now), capturedAt: now.toISOString(), currency: "MXN",
        holdings: demoWealthOverview.accounts.find(account => account.id === id)?.latestSnapshot?.holdings ?? [],
        ...(id === BITSO_ACCOUNT_ID
          ? { source: "api", totalMxnMinor: 1_250_000, fxSource: "bitso_ticker" }
          : { source: "flex", totalMxnMinor: 12_500_500, fxRate: 20, fxSource: "banxico_sf43718" }),
      };
      return { snapshot, skipped: [] };
    },
    onSuccess: async ({ snapshot }) => {
      if (demoMode) {
        queryClient.setQueryData<WealthOverview>(wealthQueryKey,
          current => withDemoMarketSnapshot(current ?? demoWealthOverview, snapshot, id));
      } else {
        await queryClient.invalidateQueries({ queryKey: wealthQueryKey });
      }
    },
  });
}

import type {
  CardLiabilitySnapshot,
  WealthAccountDefinition,
  WealthAccountId,
  WealthHolding,
  WealthSnapshot,
} from "@finance/domain";

export interface WealthAccountView extends WealthAccountDefinition {
  readonly connected: boolean;
  readonly latestSnapshot: WealthSnapshot | null;
}

export interface WealthLiabilityView {
  readonly cardId: string;
  readonly name: string;
  readonly institution?: string;
  readonly latestSnapshot: CardLiabilitySnapshot | null;
}

export interface WealthHistoryPoint {
  readonly day: string;
  readonly totalMxnMinor: number;
}

export interface WealthOverview {
  readonly currency: "MXN";
  /** Alias of assetsMxnMinor (backward compatible). */
  readonly totalMxnMinor: number;
  readonly assetsMxnMinor: number;
  readonly liabilitiesMxnMinor: number;
  readonly netMxnMinor: number;
  readonly accounts: readonly WealthAccountView[];
  readonly liabilities: readonly WealthLiabilityView[];
  readonly history: {
    readonly all: readonly WealthHistoryPoint[];
    readonly byAccount: Readonly<Partial<Record<WealthAccountId, readonly WealthHistoryPoint[]>>>;
  };
}

export const withWealthTotals = (
  overview: Omit<
    WealthOverview,
    "totalMxnMinor" | "assetsMxnMinor" | "liabilitiesMxnMinor" | "netMxnMinor" | "currency"
  > &
    Partial<Pick<WealthOverview, "totalMxnMinor" | "assetsMxnMinor" | "liabilitiesMxnMinor" | "netMxnMinor" | "currency">>,
): WealthOverview => {
  const assetsMxnMinor = overview.accounts.reduce(
    (sum, account) => sum + (account.latestSnapshot?.totalMxnMinor ?? 0),
    0,
  );
  const liabilitiesMxnMinor = overview.liabilities.reduce(
    (sum, liability) => sum + (liability.latestSnapshot?.totalMxnMinor ?? 0),
    0,
  );
  return {
    ...overview,
    currency: "MXN",
    totalMxnMinor: assetsMxnMinor,
    assetsMxnMinor,
    liabilitiesMxnMinor,
    netMxnMinor: assetsMxnMinor - liabilitiesMxnMinor,
  };
};

export type { CardLiabilitySnapshot, WealthHolding, WealthSnapshot, WealthAccountId };

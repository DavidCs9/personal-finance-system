import type {
  WealthAccountDefinition,
  WealthAccountId,
  WealthHolding,
  WealthSnapshot,
} from "@finance/domain";

export interface WealthAccountView extends WealthAccountDefinition {
  readonly connected: boolean;
  readonly latestSnapshot: WealthSnapshot | null;
}

export interface WealthHistoryPoint {
  readonly day: string;
  readonly totalMxnMinor: number;
}

export interface WealthOverview {
  readonly currency: "MXN";
  readonly totalMxnMinor: number;
  readonly accounts: readonly WealthAccountView[];
  readonly history: {
    readonly all: readonly WealthHistoryPoint[];
    readonly byAccount: Readonly<Partial<Record<WealthAccountId, readonly WealthHistoryPoint[]>>>;
  };
}

export type { WealthHolding, WealthSnapshot, WealthAccountId };

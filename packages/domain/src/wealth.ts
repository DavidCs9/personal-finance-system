import { dayKeyInZone, FINANCE_TIME_ZONE } from "./month-summary.js";

export const WEALTH_ACCOUNT_IDS = ["nu_cajita_emergencia", "bitso", "ibkr"] as const;

export type WealthAccountId = (typeof WEALTH_ACCOUNT_IDS)[number];

export type WealthAccountRole = "emergency_fund" | "crypto" | "brokerage";

export type WealthSnapshotSource = "manual" | "api" | "flex";

export const CAJITA_STALE_DAYS = 7;

export const CAJITA_ACCOUNT_ID: WealthAccountId = "nu_cajita_emergencia";
export const BITSO_ACCOUNT_ID: WealthAccountId = "bitso";
export const IBKR_ACCOUNT_ID: WealthAccountId = "ibkr";

export interface WealthHolding {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly quantity: number;
  readonly currency: string;
  readonly valueNativeMinor: number;
  readonly valueMxnMinor: number;
}

export interface WealthSnapshotEvidence {
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly contentType: "application/json";
}

export interface WealthSnapshot {
  readonly accountId: WealthAccountId;
  readonly day: string;
  readonly capturedAt: string;
  readonly source: WealthSnapshotSource;
  readonly currency: "MXN";
  readonly totalMxnMinor: number;
  readonly holdings: readonly WealthHolding[];
  readonly evidence?: WealthSnapshotEvidence;
  readonly fxRate?: number;
  readonly fxSource?: string;
}

export interface WealthAccountDefinition {
  readonly id: WealthAccountId;
  readonly name: string;
  readonly institution: string;
  readonly role: WealthAccountRole;
  readonly sync: "manual" | "api" | "flex";
}

export const WEALTH_ACCOUNTS: readonly WealthAccountDefinition[] = [
  {
    id: "nu_cajita_emergencia",
    name: "Cajita Nu",
    institution: "Nu",
    role: "emergency_fund",
    sync: "manual",
  },
  {
    id: "bitso",
    name: "Bitso",
    institution: "Bitso",
    role: "crypto",
    sync: "api",
  },
  {
    id: "ibkr",
    name: "IBKR",
    institution: "IBKR",
    role: "brokerage",
    sync: "flex",
  },
];

export const isWealthAccountId = (value: string): value is WealthAccountId =>
  (WEALTH_ACCOUNT_IDS as readonly string[]).includes(value);

/** Whole calendar days between snapshot day and `now` in the finance timezone. */
export const wealthSnapshotAgeDays = (day: string, now: Date = new Date()): number => {
  const today = dayKeyInZone(now, FINANCE_TIME_ZONE);
  const start = Date.parse(`${day}T12:00:00.000Z`);
  const end = Date.parse(`${today}T12:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((end - start) / 86_400_000));
};

export const isWealthSnapshotStale = (
  day: string | undefined,
  now: Date = new Date(),
  staleAfterDays: number = CAJITA_STALE_DAYS,
): boolean => {
  if (!day) return true;
  return wealthSnapshotAgeDays(day, now) >= staleAfterDays;
};

export const cajitaEmergencyHolding = (amountMinor: number): WealthHolding => ({
  id: "emergency_fund",
  symbol: "MXN",
  name: "Fondo de emergencia",
  quantity: amountMinor / 100,
  currency: "MXN",
  valueNativeMinor: amountMinor,
  valueMxnMinor: amountMinor,
});

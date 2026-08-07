import { dayKeyInZone, FINANCE_TIME_ZONE } from "./month-summary.js";

export const WEALTH_ACCOUNT_IDS = [
  "nu_cajita_emergencia",
  "fondo_ahorro",
  "bitso",
  "ibkr",
] as const;

export type WealthAccountId = (typeof WEALTH_ACCOUNT_IDS)[number];

export type WealthAccountRole = "emergency_fund" | "payroll_savings" | "crypto" | "brokerage";

export type WealthSnapshotSource = "manual" | "api" | "flex" | "derived";

export const CAJITA_STALE_DAYS = 7;
export const CARD_LIABILITY_STALE_DAYS = 7;

export const CAJITA_ACCOUNT_ID: WealthAccountId = "nu_cajita_emergencia";
export const FONDO_AHORRO_ACCOUNT_ID: WealthAccountId = "fondo_ahorro";
export const BITSO_ACCOUNT_ID: WealthAccountId = "bitso";
export const IBKR_ACCOUNT_ID: WealthAccountId = "ibkr";

export interface CardLiabilitySnapshot {
  readonly cardId: string;
  readonly day: string;
  readonly capturedAt: string;
  readonly source: "manual";
  readonly currency: "MXN";
  readonly totalMxnMinor: number;
  readonly evidence?: WealthSnapshotEvidence;
}

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
  readonly sync: "manual" | "api" | "flex" | "derived";
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
    id: "fondo_ahorro",
    name: "Fondo de ahorro",
    institution: "Nómina",
    role: "payroll_savings",
    sync: "derived",
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

/**
 * Patrimonio total history omits months before this (incomplete liquid+fondo mix).
 * Fixed start — not a sliding window — so prior month closes accumulate.
 */
export const WEALTH_TOTAL_HISTORY_START_MONTH = "2026-08";

export type WealthHistoryPoint = {
  readonly day: string;
  readonly totalMxnMinor: number;
};

/** Keep the latest point in each calendar month; `day` becomes YYYY-MM-01. */
export const toMonthlyHistoryCloses = (
  points: readonly WealthHistoryPoint[],
): readonly WealthHistoryPoint[] => {
  const byMonth = new Map<string, WealthHistoryPoint>();
  for (const point of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.day)) continue;
    const month = point.day.slice(0, 7);
    const current = byMonth.get(month);
    if (!current || point.day >= current.day) {
      byMonth.set(month, { day: `${month}-01`, totalMxnMinor: point.totalMxnMinor });
    }
  }
  return [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, point]) => point);
};

/** Monthly closes from `startMonth` (YYYY-MM) onward; current month forced to `currentTotalMinor`. */
export const wealthTotalMonthlyHistory = (input: {
  readonly points: readonly WealthHistoryPoint[];
  readonly currentMonth: string;
  readonly currentTotalMinor: number;
  readonly startMonth?: string;
}): readonly WealthHistoryPoint[] => {
  const startMonth = input.startMonth ?? WEALTH_TOTAL_HISTORY_START_MONTH;
  if (input.currentTotalMinor <= 0) return [];
  const monthly = toMonthlyHistoryCloses(input.points).filter(
    (point) => point.day.slice(0, 7) >= startMonth,
  );
  const withoutCurrent = monthly.filter((point) => point.day.slice(0, 7) !== input.currentMonth);
  return [...withoutCurrent, { day: `${input.currentMonth}-01`, totalMxnMinor: input.currentTotalMinor }];
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

export const fondoAhorroHolding = (amountMinor: number): WealthHolding => ({
  id: "payroll_savings",
  symbol: "MXN",
  name: "Fondo de ahorro",
  quantity: amountMinor / 100,
  currency: "MXN",
  valueNativeMinor: amountMinor,
  valueMxnMinor: amountMinor,
});

/** Carry-forward: last known balance per card as of each day (sorted ascending). */
export const liabilitiesAsOfDay = (
  snapshots: readonly CardLiabilitySnapshot[],
  day: string,
): number => {
  const latestByCard = new Map<string, CardLiabilitySnapshot>();
  for (const snapshot of [...snapshots].sort(
    (left, right) => left.day.localeCompare(right.day) || left.capturedAt.localeCompare(right.capturedAt),
  )) {
    if (snapshot.day > day) continue;
    latestByCard.set(snapshot.cardId, snapshot);
  }
  let total = 0;
  for (const snapshot of latestByCard.values()) {
    total += snapshot.totalMxnMinor;
  }
  return total;
};

export const netWorthMxnMinor = (assetsMxnMinor: number, liabilitiesMxnMinor: number): number =>
  assetsMxnMinor - liabilitiesMxnMinor;

import { describe, expect, it } from "vitest";
import {
  CAJITA_STALE_DAYS,
  CARD_LIABILITY_STALE_DAYS,
  cajitaEmergencyHolding,
  fondoAhorroHolding,
  isWealthAccountId,
  isWealthSnapshotStale,
  liabilitiesAsOfDay,
  netWorthMxnMinor,
  wealthSnapshotAgeDays,
  wealthTotalMonthlyHistory,
  type CardLiabilitySnapshot,
} from "../src/wealth.js";

describe("wealth domain", () => {
  it("recognises seeded account ids", () => {
    expect(isWealthAccountId("nu_cajita_emergencia")).toBe(true);
    expect(isWealthAccountId("fondo_ahorro")).toBe(true);
    expect(isWealthAccountId("bitso")).toBe(true);
    expect(isWealthAccountId("ibkr")).toBe(true);
    expect(isWealthAccountId("other")).toBe(false);
  });

  it("builds a single Cajita holding in MXN minor units", () => {
    expect(cajitaEmergencyHolding(1_255_000)).toEqual({
      id: "emergency_fund",
      symbol: "MXN",
      name: "Fondo de emergencia",
      quantity: 12_550,
      currency: "MXN",
      valueNativeMinor: 1_255_000,
      valueMxnMinor: 1_255_000,
    });
  });

  it("builds a fondo de ahorro holding in MXN minor units", () => {
    expect(fondoAhorroHolding(7_858_730)).toEqual({
      id: "payroll_savings",
      symbol: "MXN",
      name: "Fondo de ahorro",
      quantity: 78_587.3,
      currency: "MXN",
      valueNativeMinor: 7_858_730,
      valueMxnMinor: 7_858_730,
    });
  });

  it("marks Cajita stale after seven days", () => {
    const now = new Date("2026-08-06T18:00:00-06:00");
    expect(isWealthSnapshotStale("2026-08-06", now)).toBe(false);
    expect(isWealthSnapshotStale("2026-07-30", now)).toBe(true);
    expect(wealthSnapshotAgeDays("2026-07-30", now)).toBe(CAJITA_STALE_DAYS);
    expect(isWealthSnapshotStale(undefined, now)).toBe(true);
  });

  it("builds monthly history closes from the configured start month", () => {
    expect(
      wealthTotalMonthlyHistory({
        currentMonth: "2026-08",
        currentTotalMinor: 269_273_00,
        points: [
          { day: "2026-07-31", totalMxnMinor: 78_587_00 },
          { day: "2026-08-01", totalMxnMinor: 200_000_00 },
          { day: "2026-08-06", totalMxnMinor: 250_000_00 },
        ],
      }),
    ).toEqual([{ day: "2026-08-01", totalMxnMinor: 269_273_00 }]);
  });

  it("marks card liabilities stale after seven days", () => {
    const now = new Date("2026-08-06T18:00:00-06:00");
    expect(isWealthSnapshotStale("2026-07-30", now, CARD_LIABILITY_STALE_DAYS)).toBe(true);
    expect(isWealthSnapshotStale("2026-08-01", now, CARD_LIABILITY_STALE_DAYS)).toBe(false);
  });

  it("carries forward liability balances as of a day", () => {
    const snaps: readonly CardLiabilitySnapshot[] = [
      {
        cardId: "a",
        day: "2026-07-01",
        capturedAt: "2026-07-01T12:00:00.000Z",
        source: "manual",
        currency: "MXN",
        totalMxnMinor: 100_000,
      },
      {
        cardId: "b",
        day: "2026-07-05",
        capturedAt: "2026-07-05T12:00:00.000Z",
        source: "manual",
        currency: "MXN",
        totalMxnMinor: 50_000,
      },
      {
        cardId: "a",
        day: "2026-07-10",
        capturedAt: "2026-07-10T12:00:00.000Z",
        source: "manual",
        currency: "MXN",
        totalMxnMinor: 80_000,
      },
    ];
    expect(liabilitiesAsOfDay(snaps, "2026-06-30")).toBe(0);
    expect(liabilitiesAsOfDay(snaps, "2026-07-01")).toBe(100_000);
    expect(liabilitiesAsOfDay(snaps, "2026-07-05")).toBe(150_000);
    expect(liabilitiesAsOfDay(snaps, "2026-07-10")).toBe(130_000);
  });

  it("computes net worth", () => {
    expect(netWorthMxnMinor(1_000_000, 250_000)).toBe(750_000);
    expect(netWorthMxnMinor(100_000, 250_000)).toBe(-150_000);
  });
});

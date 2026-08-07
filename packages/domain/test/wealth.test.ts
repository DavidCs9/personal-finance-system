import { describe, expect, it } from "vitest";
import {
  CAJITA_STALE_DAYS,
  cajitaEmergencyHolding,
  fondoAhorroHolding,
  isWealthAccountId,
  isWealthSnapshotStale,
  wealthSnapshotAgeDays,
  wealthTotalMonthlyHistory,
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
});

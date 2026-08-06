import { describe, expect, it } from "vitest";
import {
  CAJITA_STALE_DAYS,
  cajitaEmergencyHolding,
  isWealthAccountId,
  isWealthSnapshotStale,
  wealthSnapshotAgeDays,
} from "../src/wealth.js";

describe("wealth domain", () => {
  it("recognises seeded account ids", () => {
    expect(isWealthAccountId("nu_cajita_emergencia")).toBe(true);
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

  it("marks Cajita stale after seven days", () => {
    const now = new Date("2026-08-06T18:00:00-06:00");
    expect(isWealthSnapshotStale("2026-08-06", now)).toBe(false);
    expect(isWealthSnapshotStale("2026-07-30", now)).toBe(true);
    expect(wealthSnapshotAgeDays("2026-07-30", now)).toBe(CAJITA_STALE_DAYS);
    expect(isWealthSnapshotStale(undefined, now)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { InvalidMonthlyPlanError, isValidMonth, monthlyPlanKey, parseMonthlyPlan } from "../src/months/monthly-plan.js";

describe("monthly plan", () => {
  it("parses upcoming payments without requiring incomeMinor", () => {
    expect(parseMonthlyPlan(JSON.stringify({
      currency: "MXN",
      upcomingPayments: [{ id: "rent", name: "Renta", amountMinor: 1280000, dueDay: 15 }],
    }))).toEqual({
      currency: "MXN",
      upcomingPayments: [{ id: "rent", name: "Renta", amountMinor: 1280000, dueDay: 15 }],
    });
  });

  it("still accepts legacy bodies that include incomeMinor", () => {
    expect(parseMonthlyPlan(JSON.stringify({
      incomeMinor: 4850000,
      currency: "MXN",
      upcomingPayments: [],
    }))).toEqual({
      currency: "MXN",
      upcomingPayments: [],
    });
  });

  it("rejects invalid plans", () => {
    for (const body of [
      JSON.stringify({ currency: "USD", upcomingPayments: [] }),
      JSON.stringify({ currency: "MXN", upcomingPayments: [{ id: "x", name: "Renta", amountMinor: 1, dueDay: 32 }] }),
    ]) {
      expect(() => parseMonthlyPlan(body)).toThrow(InvalidMonthlyPlanError);
    }
  });

  it("builds month keys", () => {
    expect(isValidMonth("2026-07")).toBe(true);
    expect(monthlyPlanKey("user-1", "2026-07")).toEqual({ PK: "USER#user-1", SK: "MONTH#2026-07" });
  });
});

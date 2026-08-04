import { describe, expect, it } from "vitest";
import { InvalidMonthlyPlanError, isValidMonth, monthlyPlanKey, parseMonthlyPlan } from "../src/months/monthly-plan.js";

describe("monthly plan validation", () => {
  it("accepts a valid monthly plan and trims payment names", () => {
    expect(parseMonthlyPlan(JSON.stringify({
      incomeMinor: 4850000,
      currency: "MXN",
      upcomingPayments: [{ id: "rent", name: "  Renta  ", amountMinor: 1280000, dueDay: 15 }],
    }))).toEqual({
      incomeMinor: 4850000,
      currency: "MXN",
      upcomingPayments: [{ id: "rent", name: "Renta", amountMinor: 1280000, dueDay: 15 }],
    });
  });

  it.each([
    undefined,
    "{}",
    JSON.stringify({ incomeMinor: 0, currency: "MXN", upcomingPayments: [] }),
    JSON.stringify({ incomeMinor: 100000, currency: "USD", upcomingPayments: [] }),
    JSON.stringify({ incomeMinor: 100000, currency: "MXN", upcomingPayments: [{ id: "x", name: "Renta", amountMinor: 1, dueDay: 32 }] }),
  ])("rejects an invalid request body", (body) => {
    expect(() => parseMonthlyPlan(body)).toThrow(InvalidMonthlyPlanError);
  });

  it("validates month keys", () => {
    expect(isValidMonth("2026-08")).toBe(true);
    expect(isValidMonth("2026-8")).toBe(false);
    expect(isValidMonth("2026-13")).toBe(false);
  });

  it("isolates plans by user and month", () => {
    expect(monthlyPlanKey("user-123", "2026-08")).toEqual({
      PK: "USER#user-123",
      SK: "MONTH#2026-08",
    });
  });
});

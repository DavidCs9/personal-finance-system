import { describe, expect, it } from "vitest";
import { paymentDueDayForMonth } from "./monthly-plan";

describe("recurring payment due day", () => {
  it("keeps the configured day when it exists in the selected month", () => {
    expect(paymentDueDayForMonth("2026-09", 30)).toBe(30);
    expect(paymentDueDayForMonth("2026-02", 15)).toBe(15);
  });

  it("uses the final calendar day for shorter months", () => {
    expect(paymentDueDayForMonth("2026-02", 31)).toBe(28);
    expect(paymentDueDayForMonth("2028-02", 31)).toBe(29);
    expect(paymentDueDayForMonth("2026-04", 31)).toBe(30);
  });
});

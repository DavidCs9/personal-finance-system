import { describe, expect, it } from "vitest";
import { deriveMonthIncome, payslipLineGroup } from "@finance/domain";

describe("payslipLineGroup", () => {
  it("maps SAT types to fondo/isr/imss", () => {
    expect(payslipLineGroup("deduccion", "004")).toBe("fondo");
    expect(payslipLineGroup("percepcion", "005")).toBe("fondo");
    expect(payslipLineGroup("deduccion", "002")).toBe("isr");
    expect(payslipLineGroup("deduccion", "001")).toBe("imss");
    expect(payslipLineGroup("otro_pago", "999")).toBe("otro");
  });
});

describe("deriveMonthIncome", () => {
  it("requires payslips to configure income", () => {
    expect(
      deriveMonthIncome({
        month: "2026-07",
        now: new Date("2026-07-20T18:00:00Z"),
        payslips: [],
      }).configured,
    ).toBe(false);
  });
});

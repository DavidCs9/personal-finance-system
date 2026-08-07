import { describe, expect, it } from "vitest";
import {
  deriveMonthIncome,
  payslipLineGroup,
  previousCalendarMonth,
  provisionalIncomeFromPriorOrdinaries,
} from "@finance/domain";

describe("payslipLineGroup", () => {
  it("maps SAT types to fondo/isr/imss", () => {
    expect(payslipLineGroup("deduccion", "004")).toBe("fondo");
    expect(payslipLineGroup("percepcion", "005")).toBe("fondo");
    expect(payslipLineGroup("deduccion", "002")).toBe("isr");
    expect(payslipLineGroup("deduccion", "001")).toBe("imss");
    expect(payslipLineGroup("otro_pago", "999")).toBe("otro");
  });
});

describe("previousCalendarMonth", () => {
  it("walks back across year boundaries", () => {
    expect(previousCalendarMonth("2026-01")).toBe("2025-12");
    expect(previousCalendarMonth("2026-08")).toBe("2026-07");
  });
});

describe("provisionalIncomeFromPriorOrdinaries", () => {
  it("doubles a single ordinary", () => {
    expect(provisionalIncomeFromPriorOrdinaries([{ totalMinor: 2_000_000, fechaPago: "2026-07-31" }])).toBe(
      4_000_000,
    );
  });

  it("sums the two newest when more exist", () => {
    expect(
      provisionalIncomeFromPriorOrdinaries([
        { totalMinor: 1_900_000, fechaPago: "2026-06-15" },
        { totalMinor: 2_000_000, fechaPago: "2026-07-15" },
        { totalMinor: 2_100_000, fechaPago: "2026-07-31" },
      ]),
    ).toBe(4_100_000);
  });
});

describe("deriveMonthIncome", () => {
  it("stays unconfigured without payslips or prior ordinaries", () => {
    expect(
      deriveMonthIncome({
        month: "2026-08",
        now: new Date("2026-08-06T18:00:00Z"),
        payslips: [],
      }).configured,
    ).toBe(false);
  });

  it("uses provisional income in the current month before any payslip", () => {
    const derived = deriveMonthIncome({
      month: "2026-08",
      now: new Date("2026-08-06T18:00:00Z"),
      payslips: [],
      priorOrdinaryPayslips: [
        { tipoNomina: "O", totalMinor: 2_200_000, fechaPago: "2026-07-15" },
        { tipoNomina: "O", totalMinor: 2_263_070, fechaPago: "2026-07-31" },
      ],
    });
    expect(derived.configured).toBe(true);
    expect(derived.provisionalActive).toBe(true);
    expect(derived.provisionalMinor).toBe(4_463_070);
    expect(derived.incomeMinor).toBe(4_463_070);
    expect(derived.depositedMinor).toBe(0);
    expect(derived.estimateActive).toBe(false);
  });

  it("does not keep provisional income after the month closes", () => {
    const derived = deriveMonthIncome({
      month: "2026-07",
      now: new Date("2026-08-06T18:00:00Z"),
      payslips: [],
      priorOrdinaryPayslips: [{ tipoNomina: "O", totalMinor: 2_000_000, fechaPago: "2026-06-30" }],
    });
    expect(derived.configured).toBe(false);
    expect(derived.provisionalActive).toBe(false);
  });

  it("drops provisional once the first payslip of the month arrives", () => {
    const derived = deriveMonthIncome({
      month: "2026-08",
      now: new Date("2026-08-16T18:00:00Z"),
      payslips: [{ tipoNomina: "O", totalMinor: 2_263_070 }],
      priorOrdinaryPayslips: [{ tipoNomina: "O", totalMinor: 2_000_000, fechaPago: "2026-07-31" }],
    });
    expect(derived.provisionalActive).toBe(false);
    expect(derived.estimateActive).toBe(true);
    expect(derived.incomeMinor).toBe(4_526_140);
  });
});

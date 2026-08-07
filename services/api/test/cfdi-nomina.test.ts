import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveMonthIncome, payslipLineGroup } from "@finance/domain";
import { InvalidCfdiNominaError, parseCfdiNominaXml } from "../src/imports/cfdi-nomina.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cfdi-nomina-sample.xml");

describe("parseCfdiNominaXml", () => {
  it("parses a CFDI nómina 1.2 fixture", () => {
    const xml = readFileSync(fixturePath, "utf8");
    const payslip = parseCfdiNominaXml(xml);
    expect(payslip.uuid).toBe("379BB2C1-2D42-4C9A-B7E6-F16C8A596234");
    expect(payslip.fechaPago).toBe("2026-07-31");
    expect(payslip.month).toBe("2026-07");
    expect(payslip.tipoNomina).toBe("O");
    expect(payslip.totalMinor).toBe(2_263_070);
    expect(payslip.totalDeduccionesMinor).toBe(1_282_047);
    expect(payslip.lines.some((line) => line.group === "fondo" && line.kind === "deduccion")).toBe(true);
    expect(payslip.lines.some((line) => line.notCashInBank)).toBe(true);
    expect(payslipLineGroup("deduccion", "004")).toBe("fondo");
    expect(payslipLineGroup("percepcion", "005")).toBe("fondo");
  });

  it("rejects non-nómina CFDIs", () => {
    expect(() =>
      parseCfdiNominaXml(
        `<?xml version="1.0"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" TipoDeComprobante="I" Total="1.00"></cfdi:Comprobante>`,
      ),
    ).toThrow(InvalidCfdiNominaError);
  });
});

describe("deriveMonthIncome", () => {
  it("estimates a twin when one ordinary payslip exists in the current month", () => {
    const derived = deriveMonthIncome({
      month: "2026-07",
      now: new Date("2026-07-20T12:00:00Z"),
      payslips: [{ tipoNomina: "O", totalMinor: 2_263_070 }],
    });
    expect(derived.configured).toBe(true);
    expect(derived.depositedMinor).toBe(2_263_070);
    expect(derived.estimatedMinor).toBe(2_263_070);
    expect(derived.incomeMinor).toBe(4_526_140);
    expect(derived.estimateActive).toBe(true);
  });

  it("drops the estimate after the calendar month closes", () => {
    const derived = deriveMonthIncome({
      month: "2026-07",
      now: new Date("2026-08-01T12:00:00Z"),
      payslips: [{ tipoNomina: "O", totalMinor: 2_263_070 }],
    });
    expect(derived.estimatedMinor).toBe(0);
    expect(derived.incomeMinor).toBe(2_263_070);
    expect(derived.estimateActive).toBe(false);
  });

  it("does not pair extraordinarias", () => {
    const derived = deriveMonthIncome({
      month: "2026-07",
      now: new Date("2026-07-20T12:00:00Z"),
      payslips: [
        { tipoNomina: "O", totalMinor: 2_000_000 },
        { tipoNomina: "E", totalMinor: 5_000_000 },
      ],
    });
    expect(derived.depositedMinor).toBe(7_000_000);
    expect(derived.estimatedMinor).toBe(2_000_000);
    expect(derived.incomeMinor).toBe(9_000_000);
  });

  it("clears estimate once two ordinarias exist", () => {
    const derived = deriveMonthIncome({
      month: "2026-07",
      now: new Date("2026-07-20T12:00:00Z"),
      payslips: [
        { tipoNomina: "O", totalMinor: 2_000_000 },
        { tipoNomina: "O", totalMinor: 2_100_000 },
      ],
    });
    expect(derived.estimateActive).toBe(false);
    expect(derived.incomeMinor).toBe(4_100_000);
  });

  it("provisions current-month income from prior ordinaries when empty", () => {
    const derived = deriveMonthIncome({
      month: "2026-08",
      now: new Date("2026-08-06T18:00:00Z"),
      payslips: [],
      priorOrdinaryPayslips: [{ tipoNomina: "O", totalMinor: 2_263_070, fechaPago: "2026-07-31" }],
    });
    expect(derived.configured).toBe(true);
    expect(derived.provisionalActive).toBe(true);
    expect(derived.incomeMinor).toBe(4_526_140);
  });
});

import { FINANCE_TIME_ZONE, monthKeyInZone } from "./month-summary.js";

const isValidMonth = (month: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

export type PayslipLineKind = "percepcion" | "deduccion" | "otro_pago";

export type PayslipLineGroup = "fondo" | "isr" | "imss" | "otro";

export interface PayslipLine {
  readonly kind: PayslipLineKind;
  readonly tipo: string;
  readonly clave: string;
  readonly concepto: string;
  readonly amountMinor: number;
  readonly group: PayslipLineGroup;
  /** Employer fondo match booked as percepción — not cash in the bank. */
  readonly notCashInBank?: boolean;
}

export interface PayslipSummary {
  readonly uuid: string;
  readonly fechaPago: string;
  readonly month: string;
  readonly tipoNomina: string;
  readonly totalMinor: number;
  readonly totalPercepcionesMinor: number;
  readonly totalDeduccionesMinor: number;
  readonly totalOtrosPagosMinor: number;
  readonly lines: readonly PayslipLine[];
  readonly employerName?: string;
  readonly fechaInicialPago?: string;
  readonly fechaFinalPago?: string;
}

export interface MonthIncomeDerivation {
  readonly configured: boolean;
  readonly depositedMinor: number;
  readonly estimatedMinor: number;
  readonly incomeMinor: number;
  readonly estimateActive: boolean;
  readonly ordinaryCount: number;
}

export const payslipLineGroup = (kind: PayslipLineKind, tipo: string): PayslipLineGroup => {
  if (kind === "deduccion" && tipo === "004") return "fondo";
  if (kind === "percepcion" && tipo === "005") return "fondo";
  if (kind === "deduccion" && tipo === "002") return "isr";
  if (kind === "deduccion" && tipo === "001") return "imss";
  return "otro";
};

export const isOrdinaryNomina = (tipoNomina: string): boolean => tipoNomina === "O";

/**
 * Month income from CFDI nóminas.
 * Liquidez = sum of deposited Totals for the month (FechaPago).
 * With exactly one ordinary payslip in the *current* calendar month, estimate a twin.
 * Past months never keep an estimate. Extraordinarias never pair.
 */
export const deriveMonthIncome = (input: {
  readonly payslips: readonly Pick<PayslipSummary, "tipoNomina" | "totalMinor">[];
  readonly month: string;
  readonly now: Date;
  readonly timeZone?: string;
}): MonthIncomeDerivation => {
  if (!isValidMonth(input.month)) {
    return {
      configured: false,
      depositedMinor: 0,
      estimatedMinor: 0,
      incomeMinor: 0,
      estimateActive: false,
      ordinaryCount: 0,
    };
  }

  const depositedMinor = input.payslips.reduce((sum, slip) => sum + slip.totalMinor, 0);
  const ordinary = input.payslips.filter((slip) => isOrdinaryNomina(slip.tipoNomina));
  const ordinaryCount = ordinary.length;
  const configured = input.payslips.length > 0;
  const currentMonth = monthKeyInZone(input.now, input.timeZone ?? FINANCE_TIME_ZONE);
  const monthIsCurrent = input.month === currentMonth;

  let estimatedMinor = 0;
  let estimateActive = false;
  if (configured && monthIsCurrent && ordinaryCount === 1) {
    estimatedMinor = ordinary[0]!.totalMinor;
    estimateActive = true;
  }

  return {
    configured,
    depositedMinor,
    estimatedMinor,
    incomeMinor: depositedMinor + estimatedMinor,
    estimateActive,
    ordinaryCount,
  };
};

export const monthFromFechaPago = (fechaPago: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) {
    throw new Error(`Invalid FechaPago: ${fechaPago}`);
  }
  return fechaPago.slice(0, 7);
};

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
  /** Current month with no payslips yet — income borrowed from prior ordinaries. */
  readonly provisionalActive: boolean;
  readonly provisionalMinor: number;
}

export const payslipLineGroup = (kind: PayslipLineKind, tipo: string): PayslipLineGroup => {
  if (kind === "deduccion" && tipo === "004") return "fondo";
  if (kind === "percepcion" && tipo === "005") return "fondo";
  if (kind === "deduccion" && tipo === "002") return "isr";
  if (kind === "deduccion" && tipo === "001") return "imss";
  return "otro";
};

export const isOrdinaryNomina = (tipoNomina: string): boolean => tipoNomina === "O";

/** Employee + employer portions withheld into the fund (SAT deducción 004). Excludes percepción 005. */
export const sumFondoAhorroDeduccionesMinor = (
  payslips: readonly Pick<PayslipSummary, "lines">[],
): number =>
  payslips.reduce(
    (sum, slip) =>
      sum +
      slip.lines
        .filter((line) => line.kind === "deduccion" && line.group === "fondo")
        .reduce((lineSum, line) => lineSum + line.amountMinor, 0),
    0,
  );

/**
 * Running YTD fondo balance by FechaPago day (America/Chihuahua calendar dates on the slip).
 * Multiple payslips on the same day accumulate into one point.
 */
export const runningFondoAhorroByDay = (
  payslips: readonly Pick<PayslipSummary, "fechaPago" | "lines">[],
): readonly { readonly day: string; readonly totalMxnMinor: number }[] => {
  const sorted = [...payslips].sort((a, b) => a.fechaPago.localeCompare(b.fechaPago));
  const byDay = new Map<string, number>();
  let running = 0;
  for (const slip of sorted) {
    const contributed = sumFondoAhorroDeduccionesMinor([slip]);
    if (contributed <= 0) continue;
    running += contributed;
    byDay.set(slip.fechaPago, running);
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, totalMxnMinor]) => ({ day, totalMxnMinor }));
};

export const previousCalendarMonth = (month: string): string | undefined => {
  if (!isValidMonth(month)) return undefined;
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 1) return `${year - 1}-12`;
  return `${year}-${String(monthNumber - 1).padStart(2, "0")}`;
};

/**
 * Provisional month income from the two most recent ordinary payslips before this month.
 * One ordinary → double it (quincena pair). Two or more → sum of the two newest.
 */
export const provisionalIncomeFromPriorOrdinaries = (
  priorOrdinary: readonly Pick<PayslipSummary, "totalMinor" | "fechaPago">[],
): number => {
  const newest = [...priorOrdinary].sort((a, b) => b.fechaPago.localeCompare(a.fechaPago));
  if (newest.length >= 2) return newest[0]!.totalMinor + newest[1]!.totalMinor;
  if (newest.length === 1) return newest[0]!.totalMinor * 2;
  return 0;
};

const emptyDerivation = (): MonthIncomeDerivation => ({
  configured: false,
  depositedMinor: 0,
  estimatedMinor: 0,
  incomeMinor: 0,
  estimateActive: false,
  ordinaryCount: 0,
  provisionalActive: false,
  provisionalMinor: 0,
});

/**
 * Month income from CFDI nóminas.
 * Liquidez = sum of deposited Totals for the month (FechaPago).
 * With exactly one ordinary payslip in the *current* calendar month, estimate a twin.
 * With zero payslips in the *current* month, use provisional income from prior ordinaries.
 * Past months never keep an estimate or provisional. Extraordinarias never pair.
 */
export const deriveMonthIncome = (input: {
  readonly payslips: readonly Pick<PayslipSummary, "tipoNomina" | "totalMinor">[];
  readonly month: string;
  readonly now: Date;
  readonly timeZone?: string;
  readonly priorOrdinaryPayslips?: readonly Pick<PayslipSummary, "totalMinor" | "fechaPago" | "tipoNomina">[];
}): MonthIncomeDerivation => {
  if (!isValidMonth(input.month)) return emptyDerivation();

  const depositedMinor = input.payslips.reduce((sum, slip) => sum + slip.totalMinor, 0);
  const ordinary = input.payslips.filter((slip) => isOrdinaryNomina(slip.tipoNomina));
  const ordinaryCount = ordinary.length;
  const currentMonth = monthKeyInZone(input.now, input.timeZone ?? FINANCE_TIME_ZONE);
  const monthIsCurrent = input.month === currentMonth;

  if (input.payslips.length === 0) {
    if (!monthIsCurrent) return emptyDerivation();
    const priorOrdinary = (input.priorOrdinaryPayslips ?? []).filter((slip) =>
      isOrdinaryNomina(slip.tipoNomina),
    );
    const provisionalMinor = provisionalIncomeFromPriorOrdinaries(priorOrdinary);
    if (provisionalMinor <= 0) return emptyDerivation();
    return {
      configured: true,
      depositedMinor: 0,
      estimatedMinor: 0,
      incomeMinor: provisionalMinor,
      estimateActive: false,
      ordinaryCount: 0,
      provisionalActive: true,
      provisionalMinor,
    };
  }

  let estimatedMinor = 0;
  let estimateActive = false;
  if (monthIsCurrent && ordinaryCount === 1) {
    estimatedMinor = ordinary[0]!.totalMinor;
    estimateActive = true;
  }

  return {
    configured: true,
    depositedMinor,
    estimatedMinor,
    incomeMinor: depositedMinor + estimatedMinor,
    estimateActive,
    ordinaryCount,
    provisionalActive: false,
    provisionalMinor: 0,
  };
};

export const monthFromFechaPago = (fechaPago: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) {
    throw new Error(`Invalid FechaPago: ${fechaPago}`);
  }
  return fechaPago.slice(0, 7);
};

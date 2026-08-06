export interface PlannedPayment {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly dueDay: number;
}

export interface PayslipLine {
  readonly kind: "percepcion" | "deduccion" | "otro_pago";
  readonly tipo: string;
  readonly clave: string;
  readonly concepto: string;
  readonly amountMinor: number;
  readonly group: "fondo" | "isr" | "imss" | "otro";
  readonly notCashInBank?: boolean;
}

export interface Payslip {
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

export interface MonthlyPlan {
  readonly month: string;
  readonly configured: boolean;
  readonly incomeMinor: number;
  readonly depositedMinor?: number;
  readonly estimatedMinor?: number;
  readonly estimateActive?: boolean;
  readonly currency: "MXN";
  readonly upcomingPayments: readonly PlannedPayment[];
  readonly payslips?: readonly Payslip[];
}

export type MonthlyPlans = Readonly<Record<string, MonthlyPlan>>;

export const demoPlans: MonthlyPlans = {
  "2026-07": {
    month: "2026-07",
    configured: true,
    incomeMinor: 4_526_140,
    depositedMinor: 2_263_070,
    estimatedMinor: 2_263_070,
    estimateActive: true,
    currency: "MXN",
    upcomingPayments: [
      { id: "payment-rent", name: "Renta", amountMinor: 1280000, dueDay: 15 },
      { id: "payment-internet", name: "Internet", amountMinor: 69900, dueDay: 18 },
      { id: "payment-insurance", name: "Seguro del auto", amountMinor: 174500, dueDay: 24 },
    ],
    payslips: [
      {
        uuid: "379BB2C1-2D42-4C9A-B7E6-F16C8A596234",
        fechaPago: "2026-07-31",
        month: "2026-07",
        tipoNomina: "O",
        totalMinor: 2_263_070,
        totalPercepcionesMinor: 3_495_117,
        totalDeduccionesMinor: 1_282_047,
        totalOtrosPagosMinor: 50_000,
        employerName: "Empresa de prueba",
        fechaInicialPago: "2026-07-16",
        fechaFinalPago: "2026-07-31",
        lines: [
          { kind: "percepcion", tipo: "001", clave: "001", concepto: "Sueldo", amountMinor: 2_854_500, group: "otro" },
          { kind: "percepcion", tipo: "029", clave: "032", concepto: "Despensa", amountMinor: 300_000, group: "otro" },
          {
            kind: "percepcion",
            tipo: "005",
            clave: "131",
            concepto: "Fondo de ahorro Empresa",
            amountMinor: 285_450,
            group: "fondo",
            notCashInBank: true,
          },
          { kind: "deduccion", tipo: "001", clave: "052", concepto: "I.M.S.S.", amountMinor: 92_611, group: "imss" },
          { kind: "deduccion", tipo: "004", clave: "067", concepto: "Fondo de ahorro", amountMinor: 285_450, group: "fondo" },
          { kind: "deduccion", tipo: "002", clave: "045", concepto: "I.S.R. mes", amountMinor: 563_369, group: "isr" },
          { kind: "deduccion", tipo: "004", clave: "181", concepto: "Fondo Ahorro Empleado", amountMinor: 285_450, group: "fondo" },
          { kind: "otro_pago", tipo: "999", clave: "145", concepto: "Apoyo Internet Teletrabajo", amountMinor: 50_000, group: "otro" },
        ],
      },
    ],
  },
};

export const emptyPlanFor = (month: string): MonthlyPlan => ({
  month,
  configured: false,
  incomeMinor: 0,
  depositedMinor: 0,
  estimatedMinor: 0,
  estimateActive: false,
  currency: "MXN",
  upcomingPayments: [],
  payslips: [],
});

export const planFor = (plans: MonthlyPlans, month: string): MonthlyPlan => plans[month] ?? emptyPlanFor(month);

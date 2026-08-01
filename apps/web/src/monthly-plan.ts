export interface PlannedPayment {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly dueDay: number;
}

export interface MonthlyPlan {
  readonly month: string;
  readonly configured: boolean;
  readonly incomeMinor: number;
  readonly currency: "MXN";
  readonly upcomingPayments: readonly PlannedPayment[];
}

export type MonthlyPlans = Readonly<Record<string, MonthlyPlan>>;

export const demoPlans: MonthlyPlans = {
  "2026-07": {
    month: "2026-07",
    configured: true,
    incomeMinor: 4850000,
    currency: "MXN",
    upcomingPayments: [
      { id: "payment-rent", name: "Renta", amountMinor: 1280000, dueDay: 15 },
      { id: "payment-internet", name: "Internet", amountMinor: 69900, dueDay: 18 },
      { id: "payment-insurance", name: "Seguro del auto", amountMinor: 174500, dueDay: 24 },
    ],
  },
};

export const emptyPlanFor = (month: string): MonthlyPlan => ({
  month,
  configured: false,
  incomeMinor: 0,
  currency: "MXN",
  upcomingPayments: [],
});

export const planFor = (plans: MonthlyPlans, month: string): MonthlyPlan => plans[month] ?? emptyPlanFor(month);

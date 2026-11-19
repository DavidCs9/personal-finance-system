import {
  addCalendarMonths, computeBudgetStatus, DEFAULT_SPEND_CATEGORIES, financialGoalFacts, incomeOccurrences, proposeExpectedIncome,
  summarizeFutureIncome, type BankCredit, type SpendingBudget,
} from "@finance/domain";
import { demoPlans, planFor } from "../monthly-plan";
import { mockFeedForMonth } from "./mock-data";
import type { BudgetHistory, BudgetStatus, GoalDetail, GoalPage, IncomeSchedule } from "./planning-types";

const demoNow = new Date("2026-07-12T18:00:00-06:00");
const at = demoNow.toISOString();
const linkedMovement = "evt_01J5A0A1";

export const demoMonthCredits = (month: string): BankCredit[] => month !== "2026-07" ? [] : [
  { movementId: "demo-severance", creditType: "income", incomeType: "finiquito", amountMinor: 82_000_00,
    description: "Finiquito · Empresa de prueba", postedOn: "2026-07-08" },
  { movementId: "demo-refund", creditType: "refund", incomeType: null, amountMinor: 1_850_00,
    description: "Devolución · Tienda de prueba", postedOn: "2026-07-10" },
  { movementId: "demo-sale", creditType: "income", incomeType: "otro", amountMinor: 4_500_00,
    description: "Venta de monitor", postedOn: "2026-07-11" },
].map(item => ({ ...item, creditType: item.creditType as BankCredit["creditType"], incomeType: item.incomeType as BankCredit["incomeType"],
  accountKind: "cash", institution: "santander_mx", accountLastFour: "1234", currency: "MXN",
  evidenceReference: item.movementId, fundEmployerKey: null }));

export const demoMonthFutureIncome = (month: string) => summarizeFutureIncome(month, demoNow,
  demoIncomeSchedule(month, month).occurrences, demoMonthCredits(month).some(item => item.creditType === "income" && item.incomeType !== "finiquito"));

export function demoBudgetStatus(month: string, plan = planFor(demoPlans, month), includeSpendTimeline = false): BudgetStatus {
  const budget: SpendingBudget | null = month >= "2026-06" && month <= "2026-08" ? {
    id: "demo-budget", entityType: "budget", scope: "recurring", effectiveMonth: "2026-06",
    revision: 1, status: "active", createdAt: at, updatedAt: at, totalMxnMinor: 2_800_000,
    allocations: [
      { categoryId: "restaurantes", amountMxnMinor: 160_000 },
      { categoryId: "viajes", amountMxnMinor: 100_000 },
      { categoryId: "supermercado", amountMxnMinor: 470_000 },
    ],
  } : null;
  const feed = mockFeedForMonth(month);
  const movements = new Map([...feed.events, ...feed.msiRelated].map(event => [event.id, event]));
  const status = computeBudgetStatus({
    month, budget, now: demoNow, fixedPayments: plan.upcomingPayments, includeSpendTimeline,
    events: [...movements.values()].map(event => ({
      ...event, amountMinor: event.amount.amountMinor, currency: event.amount.currency,
    })),
    exclusions: month === "2026-07" ? [{
      entityType: "exclusion", id: "demo-exclusion", month, movementId: linkedMovement,
      reason: "Consumo de un viaje extraordinario", status: "active", revision: 1, createdAt: at, updatedAt: at,
    }] : [],
  });
  return { ...status, generatedAt: at, categories: status.categories.map(category => ({
    ...category, label: DEFAULT_SPEND_CATEGORIES.find(item => item.id === category.categoryId)?.name ?? category.categoryId ?? "Sin categoría",
  })) };
}

export function demoBudgetHistory(fromMonth: string): BudgetHistory {
  return { months: Array.from({ length: 3 }, (_, index) => {
    const month = addCalendarMonths(fromMonth, index);
    return { ...demoBudgetStatus(month), countedSpendChangeMxnMinor: null,
      periodStatus: month < "2026-07" ? "closed" : month === "2026-07" ? "partial" : "future" };
  }) };
}

const source = { ...proposeExpectedIncome({
  action: "create", frequency: "semimonthly", name: "Nómina quincenal", employer: "Empresa de prueba",
  startDate: "2026-07-20", amountMxnMinor: 2_250_050, confidence: "estimated",
  paymentRules: [{ kind: "previous_business_day", day: 15 }, { kind: "last_business_day" }],
}, null, "demo-income", at), confirmedTerminationDate: null };

export function demoIncomeSchedule(fromMonth: string, toMonth: string): IncomeSchedule {
  const actualPayroll = Object.values(demoPlans).flatMap(plan => (plan.payslips ?? []).filter(p => p.month >= fromMonth && p.month <= toMonth)
    .map(p => ({ id: p.uuid, employer: p.employerName ?? null, paymentDate: p.fechaPago, payrollType: p.tipoNomina, netMxnMinor: p.totalMinor })));
  const occurrences = incomeOccurrences(source, fromMonth, toMonth, actualPayroll, []);
  const monthlyTotals = Array.from({ length: 3 }, (_, index) => {
    const month = addCalendarMonths(fromMonth, index);
    const scheduled = occurrences.filter(item => (item.paymentDate?.slice(0, 7) ?? item.periodMonth) === month);
    const actual = actualPayroll.filter(item => item.paymentDate.slice(0, 7) === month);
    const unknown = scheduled.filter(item => item.amountMxnMinor === null);
    const known = scheduled.reduce((total, item) => total + (item.amountMxnMinor ?? 0), 0);
    const overlap = scheduled.some(item => item.reconciliationStatus === "possible_payroll_overlap");
    return { month, expectedKnownMxnMinor: known, expectedScheduledMxnMinor: unknown.length ? null : known,
      unknownExpectedOccurrences: unknown.length, remainingExpectedMxnMinor: overlap || unknown.length ? null : known,
      provisionalCalendarOccurrences: scheduled.filter(item => item.calendarStatus === "cnbv_calendar_provisional").length,
      actualPayrollMxnMinor: actual.reduce((total, item) => total + item.netMxnMinor, 0), actualPayslipCount: actual.length,
      overlapStatus: overlap ? "unresolved_payroll_overlap" as const : "no_overlap_identified_not_reconciled" as const };
  });
  return { sources: [source], occurrences, actualPayroll, monthlyTotals, nextCursor: null };
}

const goal: GoalDetail = {
  ...financialGoalFacts({
    goal: { id: "demo-goal", name: "Viaje en familia", status: "active", revision: 2,
      originalBudgetMxnMinor: 3_200_000, totalBudgetMxnMinor: 3_800_000, targetDate: "2026-10-03", createdAt: at, updatedAt: at },
    allocations: [
      { id: "demo-stay", goalId: "demo-goal", name: "Hospedaje", allocatedMxnMinor: 1_900_000, expectedPaymentDate: "2026-09-18", status: "active", revision: 2 },
      { id: "demo-travel", goalId: "demo-goal", name: "Traslados", allocatedMxnMinor: 1_120_000, expectedPaymentDate: null, status: "active", revision: 1 },
    ],
    payments: [
      { id: "demo-deposit", allocationId: "demo-stay", paymentDate: "2026-07-07", amountMxnMinor: 800_000,
        source: "manual_attestation", ledgerMovementId: null, status: "active", revision: 1, createdAt: at, updatedAt: at },
    ],
  }),
  linkedPaymentWarnings: [],
  history: [{ operationId: "demo-goal-change", action: "update_goal", appliedAt: at }],
};
export const demoFinancialGoals: GoalPage = { goals: [goal], nextCursor: null };
export const demoGoalDetail = (goalId: string): GoalDetail => {
  if (goalId !== goal.id) throw new Error("No encontramos esta meta.");
  return goal;
};

import type {
  ActualIncomeReceipt, computeBudgetStatus, ExpectedIncome, FinancialGoalView, IncomeOccurrence,
  MonthFutureIncome, MonthlyReceivedTotal, MonthSummary, monthCashLiquidity, monthDashboardLiquidity,
  monthDashboardSpending, payrollFundReconciliation, summarizePostedCredits,
} from "@finance/domain";

type BudgetFacts = ReturnType<typeof computeBudgetStatus>;
export type BudgetCategory = BudgetFacts["categories"][number] & { readonly label: string };
export type BudgetStatus = Omit<BudgetFacts, "categories"> & {
  readonly categories: readonly BudgetCategory[];
  readonly generatedAt: string;
};
export interface MonthDashboard {
  readonly month: string;
  readonly generatedAt: string;
  readonly summary: Omit<MonthSummary, "remainingMinor" | "projectedRemainingMinor"> & {
    readonly remainingMinor: null;
    readonly projectedRemainingMinor: null;
  };
  readonly budget: BudgetStatus;
  readonly liquidity: ReturnType<typeof monthDashboardLiquidity>;
  readonly spending: ReturnType<typeof monthDashboardSpending>;
  readonly cash: ReturnType<typeof monthCashLiquidity>;
  readonly monthlyReceived?: MonthlyReceivedTotal | null;
  readonly postedCredits: ReturnType<typeof summarizePostedCredits>;
  readonly futureIncome: MonthFutureIncome;
  readonly payrollFundClosures: readonly ReturnType<typeof payrollFundReconciliation>[];
}
export interface BudgetHistory {
  readonly months: readonly (BudgetStatus & {
    readonly periodStatus: "closed" | "partial" | "future";
    readonly countedSpendChangeMxnMinor: number | null;
  })[];
}
export type IncomeSource = ExpectedIncome & { readonly confirmedTerminationDate: string | null };
export interface IncomeMonth {
  readonly month: string;
  readonly expectedScheduledMxnMinor: number | null;
  readonly expectedKnownMxnMinor: number;
  readonly remainingExpectedMxnMinor: number | null;
  readonly unknownExpectedOccurrences: number;
  readonly provisionalCalendarOccurrences: number;
  readonly actualPayrollMxnMinor: number;
  readonly actualPayslipCount: number;
  readonly overlapStatus: "unresolved_payroll_overlap" | "no_overlap_identified_not_reconciled";
}
export interface IncomeSchedule {
  readonly sources: readonly IncomeSource[];
  readonly occurrences: readonly IncomeOccurrence[];
  readonly actualPayroll: readonly ActualIncomeReceipt[];
  readonly monthlyTotals: readonly IncomeMonth[];
  readonly nextCursor?: string | null;
}
export type GoalSummary = FinancialGoalView & {
  readonly linkedPaymentWarnings: readonly { paymentId: string; ledgerMovementId: string; message: string }[];
};
export interface GoalPage {
  readonly goals: readonly GoalSummary[];
  readonly nextCursor: string | null;
}
export type GoalDetail = GoalSummary & {
  readonly history: readonly { operationId: string; action: string; appliedAt: string }[];
};

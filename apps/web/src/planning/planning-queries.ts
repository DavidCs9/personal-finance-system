import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { addCalendarMonths } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { demoBudgetHistory, demoBudgetStatus, demoFinancialGoals, demoGoalDetail, demoIncomeSchedule } from "../api/planning-demo";
import { budgetHistoryQueryKey, budgetStatusQueryKey, expectedIncomeQueryKey, financialGoalQueryKey, financialGoalsQueryKey } from "../lib/query-keys";
import type { PlanningAccess } from "./PlanningRead";

export const useBudgetStatus = (month: string, { demoMode, idToken }: PlanningAccess) => useQuery({
  queryKey: budgetStatusQueryKey(month),
  queryFn: () => demoMode ? Promise.resolve(demoBudgetStatus(month)) : ledgerApi.budgetStatus(month, idToken),
  staleTime: 30_000,
});

export const useBudgetHistory = (month: string, { demoMode, idToken }: PlanningAccess) => useQuery({
  queryKey: budgetHistoryQueryKey(month),
  queryFn: () => {
    const from = addCalendarMonths(month, -2);
    return demoMode ? Promise.resolve(demoBudgetHistory(from)) : ledgerApi.budgetHistory(from, month, idToken);
  },
});

export const useExpectedIncome = (month: string, { demoMode, idToken }: PlanningAccess) => useInfiniteQuery({
  queryKey: expectedIncomeQueryKey(month),
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => {
    const through = addCalendarMonths(month, 2);
    return demoMode ? Promise.resolve(demoIncomeSchedule(month, through)) : ledgerApi.expectedIncome(month, through, idToken, pageParam);
  },
  getNextPageParam: page => page.nextCursor ?? undefined,
});

export const useFinancialGoals = ({ demoMode, idToken }: PlanningAccess) => useInfiniteQuery({
  queryKey: financialGoalsQueryKey,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => demoMode ? Promise.resolve(demoFinancialGoals) : ledgerApi.financialGoals(idToken, pageParam),
  getNextPageParam: page => page.nextCursor ?? undefined,
});

export const useFinancialGoal = (id: string, { demoMode, idToken }: PlanningAccess) => useQuery({
  queryKey: financialGoalQueryKey(id),
  queryFn: async () => demoMode ? demoGoalDetail(id) : ledgerApi.financialGoal(id, idToken),
});

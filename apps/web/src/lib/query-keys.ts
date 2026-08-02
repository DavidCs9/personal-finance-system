export const eventsQueryKey = ["events"] as const;
export const exceptionsQueryKey = ["exceptions"] as const;
export const monthlyPlanQueryKey = (month: string) => ["monthly-plan", month] as const;

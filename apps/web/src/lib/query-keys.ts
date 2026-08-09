export const eventsQueryKey = (month: string) => ["events", month] as const;
export const eventsQueryRoot = ["events"] as const;
export const exceptionsQueryKey = ["exceptions"] as const;
export const monthlyPlanQueryKey = (month: string) => ["monthly-plan", month] as const;
export const monthlySummaryQueryKey = (month: string) => ["monthly-summary", month] as const;
export const monthlySummaryQueryRoot = ["monthly-summary"] as const;
export const cardsQueryKey = ["cards"] as const;
export const wealthQueryKey = ["wealth"] as const;

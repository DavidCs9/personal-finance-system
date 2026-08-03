export const eventsQueryKey = (month: string) => ["events", month] as const;
export const eventsQueryRoot = ["events"] as const;
export const exceptionsQueryKey = ["exceptions"] as const;
export const monthlyPlanQueryKey = (month: string) => ["monthly-plan", month] as const;
export const cardsQueryKey = ["cards"] as const;

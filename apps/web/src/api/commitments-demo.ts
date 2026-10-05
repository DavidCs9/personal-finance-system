import { addCalendarMonths, clampDayInMonth, monthKeyInZone, type CommitmentItem, type FutureCommitments } from "@finance/domain";
import { demoPlans } from "../monthly-plan";
import { mockEvents } from "./mock-data";

export const mockCommitmentsFor = (now: Date, startMonth = monthKeyInZone(now)): FutureCommitments => {
  const currentMonth = monthKeyInZone(now);
  const eligible = mockEvents.filter(event => ["accepted", "needs_review"].includes(event.status) && event.amount.currency === "MXN");
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = addCalendarMonths(startMonth, index);
    const sourceMonth = Object.keys(demoPlans).filter(key => key<=month).sort().at(-1);
    const items: CommitmentItem[] = eligible.flatMap(event => event.msi && !event.msi.needsScheduleCompletion
      ? event.msi.installments.filter(entry => entry.month===month && entry.status==="committed").map(entry => ({
        kind: "msi" as const, id: event.id, name: event.merchantRaw, amountMinor: entry.amountMinor,
        needsReview: event.status==="needs_review", installmentIndex: entry.index, installments: event.msi!.months,
        endMonth: event.msi!.installments.at(-1)!.month,
      })) : []);
    items.push(...(sourceMonth ? demoPlans[sourceMonth]!.upcomingPayments : []).map(payment => ({
      kind: "fixed" as const, id: payment.id, name: payment.name, amountMinor: payment.amountMinor,
      needsReview: false, dueDay: clampDayInMonth(payment.dueDay, month),
    })));
    const sum = (kind?: string) => items.filter(item => !kind || item.kind===kind).reduce((n,item)=>n+item.amountMinor,0);
    return { month, totalMinor: sum(), msiMinor: sum("msi"), fixedMinor: sum("fixed"),
      uncertainMinor: items.filter(item => item.needsReview).reduce((n,item)=>n+item.amountMinor,0),
      installmentCount: items.filter(item=>item.kind==="msi").length, fixedSourceMonth: sourceMonth ?? null,
      changeMinor: null as number | null, items };
  });
  months.forEach((month,index) => { if (index>0 && month.month>addCalendarMonths(currentMonth,1)) month.changeMinor=month.totalMinor-months[index-1]!.totalMinor; });
  return { currency: "MXN", currentMonth, generatedAt: now.toISOString(), months,
    nextStartMonth: addCalendarMonths(startMonth,12), incompletePlans: eligible.filter(event=>event.msi?.needsScheduleCompletion)
      .map(event=>({eventId:event.id,name:event.merchantRaw})) };
};

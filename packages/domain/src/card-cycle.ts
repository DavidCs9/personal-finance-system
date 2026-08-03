import { daysInCalendarMonth, type PushContentMode } from "./month-summary.js";

export type CardCycleKind = "cutoff" | "payment";

export interface CardCycleProfile {
  readonly id: string;
  readonly name: string;
  readonly cutOffDay: number;
  readonly paymentDueDay: number;
  readonly institution?: string;
}

export interface CardCycleReminder {
  readonly cardId: string;
  readonly name: string;
  readonly kind: CardCycleKind;
}

export interface CardCyclePushMessage {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly navigate: string;
}

/** Clamp a configured day-of-month into a real calendar day for `YYYY-MM`. */
export const clampDayInMonth = (day: number, month: string): number => {
  const days = daysInCalendarMonth(month);
  if (!Number.isInteger(day) || day < 1) return 1;
  return Math.min(day, days);
};

export const cardRemindersForDay = (
  cards: readonly CardCycleProfile[],
  month: string,
  dayOfMonth: number,
): readonly CardCycleReminder[] => {
  const reminders: CardCycleReminder[] = [];
  for (const card of cards) {
    if (clampDayInMonth(card.cutOffDay, month) === dayOfMonth) {
      reminders.push({ cardId: card.id, name: card.name, kind: "cutoff" });
    }
    if (clampDayInMonth(card.paymentDueDay, month) === dayOfMonth) {
      reminders.push({ cardId: card.id, name: card.name, kind: "payment" });
    }
  }
  return reminders;
};

export const cardCyclePushMessage = (
  reminder: CardCycleReminder,
  contentMode: PushContentMode,
  navigateUrl: string,
  dayKey: string,
): CardCyclePushMessage => {
  const kindLabel = reminder.kind === "cutoff" ? "corte" : "pago";
  const tag = `card-${reminder.kind}-${reminder.cardId}-${dayKey}`;
  if (contentMode === "private") {
    return {
      title: "Olbia",
      body: reminder.kind === "cutoff" ? "Hoy es día de corte." : "Hoy es día de pago.",
      tag,
      navigate: navigateUrl,
    };
  }
  return {
    title: `Olbia · ${kindLabel} hoy`,
    body: `${reminder.name}: día de ${kindLabel}.`,
    tag,
    navigate: navigateUrl,
  };
};

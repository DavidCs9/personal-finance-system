import type { CardCycle } from "./card-cycle";

/** Fechas tomadas de estados de cuenta reales (julio 2026). */
export const demoCards: readonly CardCycle[] = [
  {
    id: "card-amex-gold",
    name: "Amex Gold Elite",
    cutOffDay: 6,
    paymentDueDay: 27,
    institution: "american_express_mx",
  },
  {
    id: "card-amex-aeromexico",
    name: "Amex Aeroméxico",
    cutOffDay: 22,
    paymentDueDay: 4,
    institution: "american_express_mx",
  },
  {
    id: "card-santander",
    name: "Santander Unique",
    cutOffDay: 4,
    paymentDueDay: 24,
    institution: "santander_mx",
  },
];

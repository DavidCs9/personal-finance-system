import { isValidMonth } from '@finance/domain';

export { isValidMonth };

export interface PlannedPaymentRecord {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly dueDay: number;
}

export interface MonthlyPlanInput {
  readonly currency: "MXN";
  readonly upcomingPayments: readonly PlannedPaymentRecord[];
}

export class InvalidMonthlyPlanError extends Error {}

export const monthlyPlanKey = (principal: string, month: string) => ({
  PK: `USER#${principal}`,
  SK: `MONTH#${month}`,
});

export const parseMonthlyPlan = (body: string | undefined): MonthlyPlanInput => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(body ?? "");
  } catch {
    throw new InvalidMonthlyPlanError("A JSON request body is required.");
  }
  if (!candidate || typeof candidate !== "object") {
    throw new InvalidMonthlyPlanError("A monthly plan object is required.");
  }
  const input = candidate as Record<string, unknown>;
  if (input.currency !== undefined && input.currency !== "MXN") {
    throw new InvalidMonthlyPlanError("currency must be MXN.");
  }
  if (!Array.isArray(input.upcomingPayments) || input.upcomingPayments.length > 100) {
    throw new InvalidMonthlyPlanError("upcomingPayments must contain at most 100 items.");
  }
  const upcomingPayments = input.upcomingPayments.map((payment, index) => parsePayment(payment, index));
  return { currency: "MXN", upcomingPayments };
};

const parsePayment = (candidate: unknown, index: number): PlannedPaymentRecord => {
  if (!candidate || typeof candidate !== "object") {
    throw new InvalidMonthlyPlanError(`upcomingPayments[${index}] must be an object.`);
  }
  const payment = candidate as Record<string, unknown>;
  if (typeof payment.id !== "string" || payment.id.length < 1 || payment.id.length > 128) {
    throw new InvalidMonthlyPlanError(`upcomingPayments[${index}].id is invalid.`);
  }
  if (typeof payment.name !== "string" || payment.name.trim().length < 1 || payment.name.trim().length > 100) {
    throw new InvalidMonthlyPlanError(`upcomingPayments[${index}].name is invalid.`);
  }
  if (!Number.isSafeInteger(payment.amountMinor) || Number(payment.amountMinor) <= 0) {
    throw new InvalidMonthlyPlanError(`upcomingPayments[${index}].amountMinor is invalid.`);
  }
  if (!Number.isInteger(payment.dueDay) || Number(payment.dueDay) < 1 || Number(payment.dueDay) > 31) {
    throw new InvalidMonthlyPlanError(`upcomingPayments[${index}].dueDay is invalid.`);
  }
  return {
    id: payment.id,
    name: payment.name.trim(),
    amountMinor: Number(payment.amountMinor),
    dueDay: Number(payment.dueDay),
  };
};

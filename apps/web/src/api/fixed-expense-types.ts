import type { PlannedPayment } from "../monthly-plan";

type Configuration = Pick<PlannedPayment, "name" | "amountMinor" | "dueDay"> & {
  status: "active" | "archived" | "inherit";
};

export interface FixedExpenseEntry {
  id: string;
  recurring: Configuration | null;
  override: Configuration | null;
  occurrence: Configuration | null;
  linkedMovementId: string | null;
  expectedRevision: string;
}

export interface FixedExpenseChange {
  action: "create" | "update" | "archive" | "restore" | "clear_override";
  scope: "recurring" | "month";
  month: string;
  reason: string;
  paymentId?: string;
  expectedRevision?: string;
  name?: string;
  amountMinor?: number;
  dueDay?: number;
}

export interface FixedExpensePreview {
  operationId: string;
  after: Configuration;
  nextEffectiveMonth: string | null;
  linkedOccurrenceRetained: boolean;
}

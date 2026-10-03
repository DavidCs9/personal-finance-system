/** Pure installment membership used by the native SQL month-feed presentation. */

export type MonthFeedEvent = {
  readonly id: string;
  readonly msi?: {
    readonly installments?: readonly { readonly month?: string }[];
  };
};

export const eventHasInstallmentInMonth = (event: MonthFeedEvent, month: string): boolean =>
  Boolean(event.msi?.installments?.some((installment) => installment.month === month));

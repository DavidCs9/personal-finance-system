/** Read-only forecast of known MXN commitments; no assumed future income. */
export interface CommitmentItem {
  readonly kind: "msi" | "fixed";
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly needsReview: boolean;
  readonly dueDay?: number;
  readonly installmentIndex?: number;
  readonly installments?: number;
  readonly endMonth?: string;
}

export interface CommitmentMonth {
  readonly month: string;
  readonly totalMinor: number;
  readonly msiMinor: number;
  readonly fixedMinor: number;
  readonly uncertainMinor: number;
  readonly installmentCount: number;
  readonly changeMinor: number | null;
  readonly fixedSourceMonth: string | null;
  readonly items: readonly CommitmentItem[];
}

export interface FutureCommitments {
  readonly currency: "MXN";
  readonly currentMonth: string;
  readonly generatedAt: string;
  readonly months: readonly CommitmentMonth[];
  readonly nextStartMonth?: string;
  readonly incompletePlans: readonly { readonly eventId: string; readonly name: string }[];
}

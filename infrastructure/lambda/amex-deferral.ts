import { amountsWithinTolerance, MSI_AMOUNT_TOLERANCE_MINOR } from "@finance/domain";

export type DeferralCandidate = {
  readonly id: string;
  readonly amountMinor: number;
};

/**
 * Find a subset of purchases whose amounts sum to the Amex "MONTO A DIFERIR" credit.
 * One deferral can cover several >$2,400 purchases (e.g. Costco + Globale → 6,749).
 */
export const findDeferralPurchaseSubset = (
  candidates: readonly DeferralCandidate[],
  targetMinor: number,
  toleranceMinor: number = MSI_AMOUNT_TOLERANCE_MINOR,
): readonly string[] | undefined => {
  if (!Number.isSafeInteger(targetMinor) || targetMinor <= 0) return undefined;
  const eligible = candidates
    .filter((item) => Number.isSafeInteger(item.amountMinor) && item.amountMinor > 0)
    .slice()
    .sort((left, right) => right.amountMinor - left.amountMinor);
  if (eligible.length === 0) return undefined;

  for (const item of eligible) {
    if (amountsWithinTolerance(item.amountMinor, targetMinor, toleranceMinor)) {
      return [item.id];
    }
  }

  // DP subset sum for small statement-sized candidate sets.
  type Node = { readonly sum: number; readonly ids: readonly string[] };
  let states: Node[] = [{ sum: 0, ids: [] }];
  for (const item of eligible) {
    const next: Node[] = [...states];
    for (const state of states) {
      const sum = state.sum + item.amountMinor;
      if (sum > targetMinor + toleranceMinor) continue;
      const ids = [...state.ids, item.id];
      if (amountsWithinTolerance(sum, targetMinor, toleranceMinor)) return ids;
      next.push({ sum, ids });
    }
    states = next;
    if (states.length > 4_096) break;
  }
  return undefined;
};

export const isAmexDeferralCreditMerchant = (merchantRaw: string): boolean =>
  /MONTO A DIFERIR\s+MESES EN AUTOM/i.test(merchantRaw)
  || /^DIFERIR MESES EN AUTOM/i.test(merchantRaw);

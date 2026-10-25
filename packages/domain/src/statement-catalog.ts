import { clampDayInMonth } from './card-cycle.js';
import { dayKeyInZone } from './month-summary.js';
import { addCalendarMonths } from './msi.js';

export type StatementProvider = 'amex' | 'santander';
export type StatementDocumentStatus = 'processing' | 'previewed' | 'applied' | 'failed';

/** A registered PDF, independent of whether its financial reconciliation was applied. */
export interface StatementDocument {
  readonly provider: StatementProvider;
  readonly importId: string;
  readonly status: StatementDocumentStatus;
  readonly createdAt: string;
  readonly appliedAt?: string;
  readonly accountLastFour?: string;
  readonly product?: string;
  readonly period?: { readonly from: string; readonly to: string };
}

export interface StatementCycle {
  readonly month: string;
  /** Estimated from the latest observed cut. Actual document periods remain authoritative. */
  readonly expectedCut: string;
  readonly status: 'missing' | 'registered' | 'applied';
  readonly documents: readonly StatementDocument[];
}

export interface StatementAccountCoverage {
  readonly provider: StatementProvider;
  readonly accountLastFour: string;
  readonly product?: string;
  readonly firstCut: string;
  readonly latestCut: string;
  readonly expectedCutDay: number;
  readonly cycles: readonly StatementCycle[];
}

export interface StatementCatalog {
  readonly asOfDay: string;
  readonly accounts: readonly StatementAccountCoverage[];
  /** Extraction may not yet identify a card or period. Do not silently discard these files. */
  readonly unidentifiedDocuments: readonly StatementDocument[];
}

/** Read-only coverage of observed cards, never a claim that bank spending is fully reconciled. */
export const buildStatementCatalog = (documents: readonly StatementDocument[], now: Date): StatementCatalog => {
  const asOfDay = dayKeyInZone(now);
  const groups = new Map<string, StatementDocument[]>();
  const unidentifiedDocuments: StatementDocument[] = [];
  for (const document of documents) {
    if (!document.accountLastFour || !document.period) {
      unidentifiedDocuments.push(document);
      continue;
    }
    const key = `${document.provider}:${document.accountLastFour}`;
    const group = groups.get(key) ?? [];
    group.push(document);
    groups.set(key, group);
  }
  const accounts = [...groups.values()].map((group): StatementAccountCoverage => {
    const ordered = [...group].sort((a, b) => a.period!.to.localeCompare(b.period!.to)
      || a.createdAt.localeCompare(b.createdAt) || a.importId.localeCompare(b.importId));
    const first = ordered[0]!;
    const latest = ordered.at(-1)!;
    const expectedCutDay = Number(latest.period!.to.slice(8, 10));
    const byMonth = new Map<string, StatementDocument[]>();
    for (const document of ordered) {
      const month = document.period!.to.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), document]);
    }
    const cycles: StatementCycle[] = [];
    const endMonth = [asOfDay.slice(0, 7), latest.period!.to.slice(0, 7)].sort().at(-1)!;
    for (let month = first.period!.to.slice(0, 7); month <= endMonth; month = addCalendarMonths(month, 1)) {
      const expectedCut = `${month}-${String(clampDayInMonth(expectedCutDay, month)).padStart(2, '0')}`;
      const files = byMonth.get(month) ?? [];
      // On the cut day the issuer may not have issued the PDF yet.
      if (!files.length && expectedCut >= asOfDay) continue;
      cycles.push({ month, expectedCut, documents: [...files].reverse(),
        status: files.some(file => file.status === 'applied') ? 'applied' : files.length ? 'registered' : 'missing' });
    }
    return { provider: latest.provider, accountLastFour: latest.accountLastFour!, product: latest.product,
      firstCut: first.period!.to, latestCut: latest.period!.to, expectedCutDay, cycles: cycles.reverse() };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.accountLastFour.localeCompare(b.accountLastFour));
  return { asOfDay, accounts, unidentifiedDocuments: [...unidentifiedDocuments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
};

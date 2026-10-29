import { amountsWithinTolerance, markInstallmentSpent, type MsiPlan } from '@finance/domain';
import { amexMerchantsMatch, eventMerchantsMatch, matchEvidenceLine, isAutomaticAmexLabel, type EvidenceLine, type EvidenceMatchResult } from './msi-reconciliation.js';
import { classifyMsiEvidenceRow, statementMsiEvents } from './statement-reconciliation.js';
import type { BankImportRow } from './import-sql.js';
import { BankImportError } from './import-sql.js';
import { readerPool } from '../events/sql-reads.js';
import { localDate } from '../events/queries.js';
import type { JsonObject } from '../http/response.js';

export type AmexSourceRow = Omit<BankImportRow, 'status' | 'candidateEventIds' | 'candidates'> & { readonly kind: 'purchase' | 'msi' };
export interface AmexRetainedRow {
  readonly identity: string;
  readonly movementId: string;
  readonly transactionId?: string;
  readonly merchantReference?: string;
  readonly occurredOn: string;
  readonly purchaseOn?: string;
  readonly amountMinor: number;
  readonly merchantRaw: string;
  readonly installmentIndex?: number;
  readonly installmentMonths?: number;
  readonly kind: string;
}

/** Historical source assertions stay relational, including all dates and both kinds of reference. */
export const readAmexRetainedRows = async (owner: string): Promise<readonly AmexRetainedRow[]> => {
  const rows = (await readerPool().query(`SELECT DISTINCT r.*,r.occurred_on::text AS occurred_on,
    r.purchase_on::text AS purchase_on,c.movement_id::text AS movement_id FROM olbia.bank_import_rows r
    JOIN olbia.bank_imports h ON h.kind=r.kind AND h.content_sha256=r.content_sha256
    JOIN olbia.source_claims c ON c.capture_source=r.kind AND c.row_identity=r.identity
    WHERE h.owner=$1 AND h.kind IN ('amex_activity','amex_statement') AND c.outcome='linked'`, [owner])).rows;
  return rows.map(r => ({ identity: String(r.identity), movementId: String(r.movement_id),
    kind: String(r.kind), occurredOn: String(r.occurred_on), amountMinor: Number(r.amount_mxn_minor), merchantRaw: String(r.merchant_raw),
    ...(r.purchase_on != null ? { purchaseOn: String(r.purchase_on) } : {}),
    ...(r.bank_transaction_id != null ? { transactionId: String(r.bank_transaction_id) } : {}),
    ...(r.merchant_reference != null ? { merchantReference: String(r.merchant_reference) } : {}),
    ...(r.installment_index != null ? { installmentIndex: Number(r.installment_index) } : {}),
    ...(r.installment_months != null ? { installmentMonths: Number(r.installment_months) } : {}) }));
};

const sameOriginalRow = (a: AmexSourceRow, b: AmexRetainedRow): boolean =>
  a.amountMinor === b.amountMinor && a.merchantRaw === b.merchantRaw && a.occurredOn === b.occurredOn
  && a.purchaseOn === b.purchaseOn && a.installmentIndex === b.installmentIndex && a.installmentMonths === b.installmentMonths;

const sameCard = (event: JsonObject, lastFour: string): boolean =>
  event.institution === 'american_express_mx' && (event.account as JsonObject | undefined)?.lastFour === lastFour;
const daysFor = (row: { occurredOn: string; purchaseOn?: string }) => new Set([row.occurredOn, ...(row.purchaseOn ? [row.purchaseOn] : [])]);

/** A source batch is matched as a whole so two equal purchases cannot silently take the same target. */
export const classifyAmexRows = (input: {
  readonly sourceKind: 'amex_activity' | 'amex_statement';
  readonly accountLastFour: string;
  readonly rows: readonly AmexSourceRow[];
  readonly events: readonly JsonObject[];
  readonly retained: readonly AmexRetainedRow[];
  readonly claimed: ReadonlySet<string>;
}): readonly BankImportRow[] => {
  const scoped = statementMsiEvents(input.events,{institution:'american_express_mx',accountLastFour:input.accountLastFour});
  const rows = input.rows.map((row): BankImportRow => {
    const base = { ...row, candidateEventIds: [] as string[], candidates: [] as { id: string; merchantRaw: string; occurredAt?: string }[] };
    if (input.claimed.has(row.identity)) {
      if (input.sourceKind === 'amex_activity' && input.retained.some(r => r.identity === row.identity && !sameOriginalRow(row, r)))
        throw new BankImportError('Una referencia Amex ya registrada tiene datos diferentes. Revisa el archivo; no se creó otro movimiento.');
      return { ...base, status: 'duplicate' };
    }
    if (row.credit || row.amountMinor <= 0) return { ...base, status: 'excluded' };
    if (row.kind === 'msi') {
      if (!row.installmentIndex || !row.installmentMonths)
        return { ...base, status: 'needs_decision',reason:'incomplete_msi_schedule' };
      // Include already-spent cuotas and incomplete plans when detecting ambiguity.
      const possible = scoped.filter(event => {
        const plan = event.msi as MsiPlan | undefined;
        if (!plan || plan.months !== row.installmentMonths || !amountsWithinTolerance(plan.cuotaMinor, row.amountMinor)) return false;
        if (row.originalAmountMinor !== undefined && !amountsWithinTolerance(plan.principalMinor, row.originalAmountMinor)) return false;
        return isAutomaticAmexLabel(row.merchantRaw) || eventMerchantsMatch(event, row.merchantRaw);
      });
      const labels = possible.map(e => ({ id: String(e.id), merchantRaw: String(e.merchantRaw), occurredAt: e.occurredAt as string | undefined }));
      if (possible.length > 1 || possible.some(e => e.status === 'rejected' || (e.msi as MsiPlan).needsScheduleCompletion))
        return { ...base, status: 'needs_decision',reason:possible.some(e=>e.status==='rejected' || (e.msi as MsiPlan).needsScheduleCompletion)?'conflicting_msi_plan':'ambiguous_msi_match', candidateEventIds: labels.map(c => c.id), candidates: labels };
      const result = classifyMsiEvidenceRow(row,input.events,{institution:'american_express_mx',accountLastFour:input.accountLastFour});
      if (possible.length && (result.status !== 'matched' || (possible[0].msi as MsiPlan).installments
        .find(i => i.index === row.installmentIndex)?.month !== row.occurredOn.slice(0, 7)))
        return { ...base, status: 'needs_decision',reason:'conflicting_msi_plan', candidateEventIds: labels.map(c => c.id), candidates: labels };
      return { ...base, ...result, ...(result.status === 'skipped' ? { status: 'duplicate' as const } : {}) };
    }
    const days = daysFor(row);
    const candidates = input.events.filter(event => {
      if (event.institution !== 'american_express_mx' || event.msi) return false;
      const account = event.account as JsonObject | undefined;
      if (account?.lastFour && account.lastFour !== input.accountLastFour) return false;
      const amount = event.amount as JsonObject | undefined;
      if (amount?.currency !== 'MXN' || amount.amountMinor !== row.amountMinor
        || !amexMerchantsMatch(String(event.merchantRaw), row.merchantRaw)) return false;
      const history = input.retained.filter(r => r.movementId === event.id);
      // Two distinct native bank references are two purchases, even with identical signatures.
      if (input.sourceKind === 'amex_activity' && history.some(r => r.kind === 'amex_activity' && r.transactionId !== row.transactionId)) return false;
      const refMatch = row.merchantReference && history.some(r => r.merchantReference === row.merchantReference);
      const nearReference = refMatch && history.some(r => r.merchantReference === row.merchantReference && [...daysFor(r)]
        .some(day => [...days].some(current => Math.abs(Date.parse(day) - Date.parse(current)) <= 3 * 86_400_000)));
      return Boolean(nearReference) || days.has(localDate(event.occurredAt ?? event.receivedAt) ?? '')
        || history.some(r => [...daysFor(r)].some(day => days.has(day)));
    });
    const labels = candidates.map(e => ({ id: String(e.id), merchantRaw: String(e.merchantRaw),
      ...(typeof e.occurredAt === 'string' ? { occurredAt: e.occurredAt } : {}) }));
    const safe = candidates.length === 1 && sameCard(candidates[0], input.accountLastFour) && candidates[0].status !== 'rejected';
    return { ...base, status: candidates.length ? safe ? 'matched' : 'ambiguous' : 'new',
      ...(safe ? { eventId: String(candidates[0].id) } : {}), candidateEventIds: labels.map(c => c.id), candidates: labels };
  });
  const targetCounts = new Map<string, number>();
  for (const row of rows.filter(r => r.status === 'matched' || r.status === 'ambiguous' || r.status === 'needs_decision'))
    for (const id of row.candidateEventIds) { const key = row.kind === 'msi' ? `${id}:${row.installmentIndex}` : id;
      targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1); }
  return rows.map(row => row.status === 'matched' && row.candidateEventIds.some(id => (targetCounts.get(row.kind === 'msi' ? `${id}:${row.installmentIndex}` : id) ?? 0) > 1)
    ? { ...row, status: row.kind === 'msi' ? 'needs_decision' : 'ambiguous', eventId: undefined } : row);
};

export const scopedAmexEvents = (events: readonly JsonObject[], accountLastFour: string) =>
  statementMsiEvents(events,{institution:'american_express_mx',accountLastFour});

/** Explicit selection may disambiguate generic Amex labels, but never incompatible terms or cancelled cuotas. */
export const selectedAmexMsi = (line: EvidenceLine, event: JsonObject): EvidenceMatchResult => {
  const plan = event.msi as MsiPlan | undefined;
  const installment = plan?.installments.find(i => i.index === line.installmentIndex);
  if (!plan || plan.needsScheduleCompletion || event.status === 'rejected' || plan.months !== line.installmentMonths
    || !amountsWithinTolerance(plan.cuotaMinor, line.amountMinor) || !installment || installment.status === 'cancelled'
    || line.originalAmountMinor !== undefined && !amountsWithinTolerance(plan.principalMinor, line.originalAmountMinor)
    || !isAutomaticAmexLabel(line.merchantRaw) && !eventMerchantsMatch(event, line.merchantRaw))
    return { kind: 'needs_decision', reason: 'incompatible_plan', candidates: [] };
  return { kind: 'confirm', eventId: String(event.id), previous: plan, installmentIndex: installment.index,
    next: markInstallmentSpent(plan, installment.index, { amountMinor: line.amountMinor, occurredOn: line.occurredOn,
      confirmedAt: new Date().toISOString(), evidenceObservationId: line.identity }) };
};
export { matchEvidenceLine };

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { amountsWithinTolerance, budgetMonth, dayKeyInZone, FinancialPlanError, financialId, financialObject,
  financialText, isMsiLikeMerchant, markInstallmentSpent, type MsiPlan } from '@finance/domain';
import { readLedgerDetail, readLedgerMovements, readSourceClaim, type SqlClient } from '@finance/ledger/native-ledger';
import { readerPool, withLedgerReadSnapshot } from '../events/sql-reads.js';
import { persistEventMsi } from '../events/mutations.js';
import { bankClaimToken, bankPlanEvidence, linkBankEvidence } from '../imports/bank-ledger.js';
import { readBankImport, type BankImportKind } from '../imports/import-sql.js';
import { amexMerchantsMatch, buildPlanFromCreateDecision, hasCompleteMsiPlanEvidence, type EvidenceLine } from '../imports/msi-reconciliation.js';
import { InvalidMonthlyPlanError } from '../months/monthly-plan.js';
import { parsePaymentReconciliationInput, PaymentReconciliationConflictError, validatePaymentReconciliation,
  writePaymentReconciliation } from '../months/reconciliation.js';

const conflict = (message: string): never => { throw new FinancialPlanError(message, 'conflict'); };

export const fixedReconciliationProposal = async (client: SqlClient, owner: string, input: Record<string, unknown>) => {
  const month = budgetMonth(input.month), paymentId = financialText(input.paymentId, 'paymentId');
  const action = input.action;
  if (action !== 'link' && action !== 'unlink') throw new FinancialPlanError('Usa link o unlink.');
  // Gateway string properties can be omitted. Omission means no previous link for link only.
  const expectedEventId = input.expectedEventId == null ? null : financialId(input.expectedEventId);
  if (action === 'unlink' && !expectedEventId) throw new FinancialPlanError('Para desvincular, indica el movimiento vinculado actual.');
  if (action === 'unlink' && input.eventId != null) throw new FinancialPlanError('No indiques un movimiento nuevo para desvincular.');
  const eventId = action === 'link' ? financialId(input.eventId) : null;
  const reason = financialText(input.reason, 'Motivo');
  try {
    const expected = parsePaymentReconciliationInput(JSON.stringify({ eventId, expectedEventId, expectedPayment: input.expectedPayment }));
    const checked = await validatePaymentReconciliation(client, owner, month, paymentId, expected);
    if (checked.previous !== expectedEventId) conflict('El vínculo cambió. Consulta get_month_details antes de volver a conciliar.');
    const before = { month, paymentId, sourceMonth: checked.plan.month, payment: checked.payment,
      eventId: checked.previous, linkedAt: checked.linkedAt };
    const after = { action, month, paymentId, eventId, expectedEventId, expectedPayment: expected.expectedPayment, reason };
    return { before, after, evidence: { movement: checked.candidate ?? null }, checked,
      movementId: (eventId ?? expectedEventId)! };
  } catch (error) {
    if (error instanceof PaymentReconciliationConflictError) throw new FinancialPlanError(error.message, 'conflict');
    if (error instanceof InvalidMonthlyPlanError) throw new FinancialPlanError(error.message);
    throw error;
  }
};

export const applyFixedReconciliation = (client: SqlClient, owner: string,
  proposal: Awaited<ReturnType<typeof fixedReconciliationProposal>>, appliedAt: string) =>
  writePaymentReconciliation(client, owner, proposal.after.month, proposal.checked, appliedAt);

const bankKinds = ['amex_statement', 'amex_activity', 'santander_statement', 'santander_csv'] as const;
const bankRef = (value: unknown) => {
  const ref = financialObject(value);
  if (!(bankKinds as readonly unknown[]).includes(ref.kind) || typeof ref.importId !== 'string' || !/^[a-f0-9]{64}$/.test(ref.importId)
    || !Number.isInteger(ref.rowPosition) || Number(ref.rowPosition) < 0 || Number(ref.rowPosition) > 2997)
    throw new FinancialPlanError('Usa kind, importId y rowPosition devueltos por get_msi_reconciliation.');
  return { kind: ref.kind as BankImportKind, importId: ref.importId, rowPosition: Number(ref.rowPosition) };
};

const movementFacts = (event: Record<string, unknown>) => ({
  movementId: String(event.id), merchant: String(event.merchantRaw), institution: String(event.institution), status: String(event.status),
  amount: financialObject(event.amount), observedOn: dayKeyInZone(new Date(String(event.occurredAt ?? event.receivedAt))),
  cardLastFour: (event.account as Record<string, unknown> | undefined)?.lastFour ?? null,
  bankTransactionId: event.bankTransactionId ?? null, personalAmountMinor: event.personalAmountMinor ?? null,
  plan: (event.msi as MsiPlan | undefined) ?? null,
});
const revisionOf = (event: ReturnType<typeof movementFacts>) => createHash('sha256').update(JSON.stringify(event)).digest('hex');

export const getMsiReconciliation = (owner: string, input: Record<string, unknown>) => {
  const month = budgetMonth(input.month);
  const movementId = input.movementId === undefined ? undefined : financialId(input.movementId);
  const merchant = input.merchant === undefined ? '' : financialText(input.merchant, 'Comercio');
  const limit = input.limit ?? 20, offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50 || !Number.isSafeInteger(offset) || Number(offset) < 0)
    throw new FinancialPlanError('Usa limit 1–50 y offset no negativo.');
  return withLedgerReadSnapshot(async () => {
    const client = readerPool();
    const movements = movementId ? await readLedgerMovements(client, { ids: [movementId] })
      : (await readLedgerMovements(client, { months: [month] })).filter(row => row.msi
        && String(row.merchantRaw).toLocaleLowerCase('es').includes(merchant.toLocaleLowerCase('es')));
    if (movementId && !movements.length) throw new FinancialPlanError('Movimiento no encontrado.', 'not_found');
    const evidenceRows = (await client.query(`SELECT r.kind,r.content_sha256,r.position,r.occurred_on::text,r.merchant_raw,
        r.amount_mxn_minor,r.installment_index,r.installment_months,r.original_amount_mxn_minor,r.purchase_on::text,
        b.account_last_four,i.movement_id::text AS linked_movement_id,i.installment_index AS linked_installment_index
      FROM olbia.bank_import_rows r JOIN olbia.bank_imports b USING(kind,content_sha256)
      LEFT JOIN olbia.installment_entries i ON i.evidence_import_kind=r.kind
        AND i.evidence_content_sha256=r.content_sha256 AND i.evidence_row_position=r.position
      WHERE b.owner=$1 AND b.status='applied' AND r.occurred_on >= ($2 || '-01')::date
        AND r.occurred_on < (($2 || '-01')::date + interval '1 month') AND r.is_credit IS DISTINCT FROM TRUE
        AND r.amount_mxn_minor>0 AND (r.row_kind='msi' OR r.installment_index IS NOT NULL OR
          (r.kind='santander_csv' AND r.merchant_raw ~* '(MSI|MENSUALIDADES|MESES)'))
        AND ($3='' OR strpos(lower(r.merchant_raw),lower($3))>0)
      ORDER BY r.occurred_on,r.kind,r.content_sha256,r.position LIMIT $4 OFFSET $5`,
    [owner, month, merchant, Number(limit) + 1, offset])).rows;
    const page = movements.slice(Number(offset), Number(offset) + Number(limit));
    return {
      month, currency: 'MXN',
      movements: page.map(row => { const facts = movementFacts(row); return { ...facts, expectedRevision: revisionOf(facts) }; }),
      bankRows: evidenceRows.slice(0, Number(limit)).map(row => ({
        bankRow: { kind: row.kind, importId: row.content_sha256, rowPosition: row.position },
        merchant: row.merchant_raw, occurredOn: row.occurred_on, amountMxnMinor: Number(row.amount_mxn_minor),
        installmentIndex: row.installment_index, installmentMonths: row.installment_months,
        originalAmountMxnMinor: row.original_amount_mxn_minor == null ? null : Number(row.original_amount_mxn_minor),
        purchaseOn: row.purchase_on, cardLastFour: row.account_last_four,
        linkedMovementId: row.linked_movement_id, linkedInstallmentIndex: row.linked_installment_index,
      })),
      nextOffset: movements.length > Number(offset) + Number(limit) || evidenceRows.length > Number(limit)
        ? Number(offset) + Number(limit) : null,
    };
  });
};

export const planFromMsiEvidence = (previous: MsiPlan | null, line: EvidenceLine,
  action: 'reconcile_installment' | 'correct_schedule', at: string): { plan: MsiPlan; index: number } => {
  const month = line.occurredOn.slice(0, 7);
  const index = line.installmentIndex ?? previous?.installments.find(item => item.month === month)?.index;
  if (!index) throw new FinancialPlanError('La evidencia no identifica el número de cuota.');
  if (action === 'reconcile_installment') {
    const target = previous?.installments.find(item => item.index === index);
    if (!previous || !target || previous.needsScheduleCompletion || target.status === 'cancelled' || target.month !== month
      || (line.installmentMonths !== undefined && line.installmentMonths !== previous.months))
      throw new FinancialPlanError('La cuota no coincide con el calendario vigente. Revisa los términos bancarios antes de corregirlo.');
    return { index, plan: markInstallmentSpent(previous, index, {
      amountMinor: line.amountMinor, occurredOn: line.occurredOn, evidenceObservationId: line.identity, confirmedAt: at,
    }) };
  }
  if (!hasCompleteMsiPlanEvidence(line)) throw new FinancialPlanError('Corregir el calendario requiere principal, cuota y número/plazo impresos en el estado.');
  const rebuilt = buildPlanFromCreateDecision(line, { months: line.installmentMonths!, cuotaMinor: line.amountMinor, confirmedAt: at });
  const installments = [...rebuilt.installments];
  for (const item of previous?.installments ?? []) {
    if (item.status === 'committed') continue;
    const slot = installments[item.index - 1];
    if (!slot || slot.month !== item.month || (item.index === index && item.status === 'cancelled'))
      conflict('La corrección movería o retiraría cuotas ya registradas o canceladas. Revisa la evidencia de esas cuotas.');
    if (item.index !== index) installments[item.index - 1] = item;
  }
  return { index, plan: { ...rebuilt, origin: previous?.origin === 'amex_auto' ? 'amex_auto' : rebuilt.origin,
    installments, status: installments.some(item => item.status === 'committed') ? 'active' : 'completed' } };
};

export const msiReconciliationProposal = async (client: SqlClient, owner: string, input: Record<string, unknown>, at: string) => {
  const movementId = financialId(input.movementId), ref = bankRef(input.bankRow);
  const action = input.action;
  if (action !== 'reconcile_installment' && action !== 'correct_schedule') throw new FinancialPlanError('Usa reconcile_installment o correct_schedule.');
  const reason = financialText(input.reason, 'Motivo');
  const [event, record] = await Promise.all([readLedgerDetail(client, movementId), readBankImport(ref.kind, ref.importId, owner, client)]);
  if (!event) throw new FinancialPlanError('Movimiento no encontrado.', 'not_found');
  const before = movementFacts(event);
  if (input.expectedRevision !== revisionOf(before)) conflict('El movimiento o su plan cambió. Vuelve a consultar get_msi_reconciliation.');
  const row = record?.rows[ref.rowPosition];
  if (record?.status !== 'applied' || !row || row.credit || row.amountMinor <= 0
    || row.occurredOn > dayKeyInZone(new Date(at))
    || !(row.kind === 'msi' || row.installmentIndex !== undefined || isMsiLikeMerchant(row.merchantRaw)))
    throw new FinancialPlanError('La fila debe acreditar una cuota en una importación bancaria aplicada de Olbia.');
  const institution = ref.kind.startsWith('amex_') ? 'american_express_mx' : 'santander_mx';
  if (before.institution !== institution || before.amount.currency !== 'MXN' || before.personalAmountMinor !== null
    || !['accepted', 'needs_review'].includes(before.status) || !record.accountLastFour
    || (before.cardLastFour !== null && before.cardLastFour !== record.accountLastFour))
    throw new FinancialPlanError('El movimiento no es compatible con el banco, tarjeta o importes propios de esa cuota.');

  const [claim, priorMatches, fixed] = await Promise.all([
    readSourceClaim(client, ref.kind, bankClaimToken(row.identity)),
    client.query(`SELECT movement_id::text,installment_index FROM olbia.installment_entries
      WHERE evidence_import_kind=$1 AND evidence_content_sha256=$2 AND evidence_row_position=$3`,
    [ref.kind, ref.importId, ref.rowPosition]),
    client.query('SELECT payment_id FROM olbia.planned_payment_charges WHERE movement_id=$1', [movementId]),
  ]);
  if (fixed.rows.length) conflict('El movimiento cubre un gasto fijo. Desvincúlalo antes de pasarlo a MSI.');
  if (claim && (claim.outcome !== 'linked' || claim.movement_id !== movementId || (claim.owner && claim.owner !== owner)))
    conflict('Esa fila ya está asociada a otro movimiento o decisión bancaria.');
  const line: EvidenceLine = { ...row, originalOn: row.purchaseOn ?? row.originalOn };
  const { plan, index } = planFromMsiEvidence(before.plan, line, action, at);
  if (priorMatches.rows.some(item => item.movement_id !== movementId || item.installment_index !== index))
    conflict('La fila bancaria ya acredita otra cuota.');

  const principal = before.plan?.principalMinor ?? Number(before.amount.amountMinor);
  const principalMatches = line.originalAmountMinor !== undefined && amountsWithinTolerance(principal, line.originalAmountMinor);
  const identityMatches = Boolean(claim || priorMatches.rows.length
    || (row.transactionId && row.transactionId === before.bankTransactionId));
  const dateMatches = line.originalOn ? line.originalOn === before.observedOn
    : before.plan ? before.plan.installments.some(item => item.index === index && item.month === line.occurredOn.slice(0, 7))
      : line.occurredOn === before.observedOn;
  if (!identityMatches && (!principalMatches || !dateMatches || before.cardLastFour !== record.accountLastFour
    || !amexMerchantsMatch(before.merchant, row.merchantRaw)))
    throw new FinancialPlanError('La fila y la compra no tienen identidad bancaria compatible. Revisa comercio, principal, fecha y tarjeta.');
  const old = before.plan?.installments.find(item => item.index === index);
  if (old?.evidenceObservationId && old.evidenceObservationId !== row.identity && !identityMatches && old.occurredOn !== row.occurredOn)
    conflict('La cuota ya tiene evidencia de otra fecha. Revisa ambas filas bancarias.');
  const evidence = { ref, identity: row.identity, merchant: row.merchantRaw, amountMinor: row.amountMinor,
    occurredOn: row.occurredOn, originalOn: line.originalOn ?? null, originalAmountMinor: row.originalAmountMinor ?? null,
    installmentIndex: row.installmentIndex ?? null, installmentMonths: row.installmentMonths ?? null,
    accountLastFour: record.accountLastFour, claimMovementId: claim?.movement_id ?? null, priorMatches: priorMatches.rows };
  const unchanged = old?.evidenceObservationId === row.identity && old?.amountMinor === row.amountMinor
    && old?.occurredOn === row.occurredOn && old?.status === 'spent'
    && (action === 'reconcile_installment' ||
      isDeepStrictEqual({ ...plan, installments: plan.installments.map(item => item.index === index ? old : item) }, before.plan))
    && priorMatches.rows.length === 1;
  return { before, after: { action, movementId, bankRow: ref, expectedRevision: revisionOf(before), reason, plan },
    evidence, record, row, claim, unchanged };
};

export const applyMsiReconciliation = async (owner: string, proposed: Awaited<ReturnType<typeof msiReconciliationProposal>>, appliedAt: string) => {
  const { after, before, record, row, claim, unchanged } = proposed;
  if (unchanged) return before.plan!;
  if (!claim) {
    const linked = await linkBankEvidence({ record, row, eventId: after.movementId, appliedAt,
      parserVersion: 'olbia-msi-reconciliation-v1', reason: after.reason,
      account: { institution: before.institution, lastFour: record.accountLastFour! } });
    if (!linked) conflict('La evidencia cambió después del preview.');
  }
  if (!await persistEventMsi(after.movementId, owner, before.plan, after.plan, after.reason, bankPlanEvidence(record, row, after.plan)))
    conflict('El movimiento cambió después del preview.');
  return after.plan;
};

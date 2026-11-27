import { hasManualMovementEvidence, isBankCredit, movementAmountMatches } from './credit-verification.js';
import { createHash, randomUUID } from 'node:crypto';
import { withSqlTransaction } from '@finance/ledger/sql-runtime';
import { appendLedgerObservation, insertLedgerMovement, insertLedgerRevision, insertSourceClaim,
  markMovementReconciled, readBankCredit, readLedgerDetail, readLedgerMovements, readSourceClaim,
  withLedgerMutationBudget, reserveLedgerMutations, LedgerMutationBudgetError,
  type BankRowEvidence } from '@finance/ledger/native-ledger';
import type { MsiPlan } from '@finance/domain';
import type { ObservedEventInput } from '@finance/ledger/native-ledger';
import { readerPool, withLedgerReadSnapshot } from '../events/sql-reads.js';
import { BankImportError, type BankImportKind, type BankImportRecord, type BankImportRow } from './import-sql.js';

export const bankClaimToken = (identity: string): string => createHash('sha256').update(identity).digest('hex');
export const withBankApplyTransaction = async <T>(callback: () => Promise<T>): Promise<T> => {
  try { return await withSqlTransaction(() => withLedgerMutationBudget(callback)); }
  catch (error) {
    if (error instanceof LedgerMutationBudgetError)
      throw new BankImportError('El archivo tiene demasiadas filas para guardarlo en una sola operación.');
    throw error;
  }
};
export interface BankMsiAssertion {
  readonly institution: string;
  readonly accountLastFour: string;
  readonly merchantRaw: string;
  readonly originalAmountMinor?: number;
  readonly installmentMonths?: number;
  readonly merchantReference?: string;
}

/** Retained bank-row FKs identify the same purchase in later statements, even after a display-name edit. */
export const bankLedgerEvents = (owner?: string): Promise<Record<string, unknown>[]> => withLedgerReadSnapshot(async () => {
  const client = readerPool();
  const movements = await readLedgerMovements(client);
  if (owner) {
    const credits = (await client.query(`SELECT c.posted_on::text, c.account_kind, m.id, m.institution, m.merchant_raw,
      m.account_last_four, m.amount_minor, m.bank_transaction_id, m.status,
      (SELECT jsonb_agg(o.capture_source ORDER BY o.position) FROM olbia.ledger_observations o WHERE o.movement_id=m.id) AS capture_sources
      FROM olbia.ledger_credit_details c JOIN olbia.ledger_movements m ON m.id=c.movement_id
      JOIN olbia.source_claims s ON s.movement_id=m.id AND s.observation_id=m.primary_observation_id
      WHERE s.owner=$1 AND m.status='accepted' AND c.account_kind='credit_card'`, [owner])).rows;
    movements.push(...credits.map(row => ({ id: row.id, institution: row.institution, eventType: 'bank_credit',
      merchantRaw: row.merchant_raw, status: row.status, amount: { amountMinor: Number(row.amount_minor), currency: 'MXN' },
      account: { lastFour: row.account_last_four }, accountKind: row.account_kind, postedOn: row.posted_on,
      bankTransactionId: row.bank_transaction_id, captureSources: row.capture_sources })));
  }
  const assertions = (await client.query(`SELECT DISTINCT i.movement_id,b.kind,b.account_last_four,
    r.merchant_raw,r.original_amount_mxn_minor,r.installment_months,r.merchant_reference
    FROM olbia.installment_entries i JOIN olbia.bank_import_rows r
      ON r.kind=i.evidence_import_kind AND r.content_sha256=i.evidence_content_sha256 AND r.position=i.evidence_row_position
    JOIN olbia.bank_imports b ON b.kind=r.kind AND b.content_sha256=r.content_sha256
    WHERE i.evidence_origin='bank_row'`)).rows;
  const manual = (await client.query(`SELECT i.movement_id,o.institution,o.account_last_four,o.merchant_raw
    FROM olbia.installment_entries i JOIN olbia.ledger_observations o
      ON o.movement_id=i.movement_id AND o.id=i.manual_observation_id
    WHERE i.evidence_origin='manual_observation' AND o.account_last_four IS NOT NULL`)).rows;
  const ambiguous = new Set((await client.query('SELECT DISTINCT movement_id FROM olbia.installment_evidence_candidates')).rows.map(row=>row.movement_id));
  return movements.map(event => ({...event, hasUnresolvedBankMsiEvidence:ambiguous.has(event.id),
    manualMsiAssertions: manual.filter(row => row.movement_id === event.id).map(row => ({
      institution: row.institution, accountLastFour: row.account_last_four, merchantRaw: row.merchant_raw,
    })),
    bankMsiAssertions: assertions.filter(row => row.movement_id === event.id).map(row => ({
    institution: row.kind === 'amex_statement' || row.kind === 'amex_activity' ? 'american_express_mx' : 'santander_mx',
    accountLastFour: String(row.account_last_four ?? ''), merchantRaw: String(row.merchant_raw),
    ...(row.original_amount_mxn_minor != null ? {originalAmountMinor:Number(row.original_amount_mxn_minor)} : {}),
    ...(row.installment_months != null ? {installmentMonths:Number(row.installment_months)} : {}),
    ...((row.kind === 'amex_statement' || row.kind === 'amex_activity') && row.merchant_reference != null ? {merchantReference:String(row.merchant_reference)} : {}),
  } satisfies BankMsiAssertion))}));
});
export const claimedBankRows = async (kind: BankImportKind, identities: readonly string[]): Promise<ReadonlySet<string>> => {
  if (!identities.length) return new Set();
  const tokens = identities.map(bankClaimToken);
  const claimed = new Set((await readerPool().query(
    'SELECT token FROM olbia.source_claims WHERE capture_source=$1 AND token=ANY($2::text[])', [kind, tokens],
  )).rows.map(row => String(row.token)));
  return new Set(identities.filter((_, index) => claimed.has(tokens[index])));
};

export const bankRowPosition = (record: BankImportRecord, row: BankImportRow): number => {
  const matches = record.rows.flatMap((retained, position) => retained.identity === row.identity ? [{ retained, position }] : []);
  if (matches.length !== 1) throw new BankImportError('La evidencia de la fila cambió. Vuelve a revisar el archivo.');
  const { retained, position } = matches[0];
  for (const field of ['merchantRaw', 'amountMinor', 'occurredOn', 'rowNumber', 'transactionId',
    'installmentIndex', 'installmentMonths', 'originalAmountMinor', 'occurrence', 'kind', 'credit', 'purchaseOn', 'merchantReference'] as const)
    if (retained[field] !== row[field]) throw new BankImportError('La evidencia de la fila cambió. Vuelve a revisar el archivo.');
  return position;
};
export const bankPlanEvidence = (record: BankImportRecord, row: BankImportRow, plan: MsiPlan): readonly BankRowEvidence[] => {
  const matches = plan.installments.filter(item => item.evidenceObservationId === row.identity);
  if (matches.length !== 1) throw new BankImportError('La confirmación MSI no identifica una sola cuota.');
  return [{ kind: record.kind, contentSha256: record.importId, rowPosition: bankRowPosition(record, row),
    installmentIndex: matches[0].index }];
};
export const assertPreparedImport = (current: BankImportRecord, prepared: BankImportRecord): void => {
  if (current.previewedAt !== prepared.previewedAt || current.extractionKey !== prepared.extractionKey
    || current.textractJobId !== prepared.textractJobId || current.source.bucket !== prepared.source.bucket
    || current.source.key !== prepared.source.key || current.source.sha256 !== prepared.source.sha256)
    throw new BankImportError('La importación cambió. Vuelve a revisar el archivo.');
};

export const createBankMovement = (input: {
  readonly record: BankImportRecord; readonly row: BankImportRow; readonly event: ObservedEventInput;
}): Promise<Record<string, unknown> | undefined> => withSqlTransaction(async client => {
  const { record, row, event } = input;
  bankRowPosition(record, row);
  const token = bankClaimToken(row.identity);
  if (await readSourceClaim(client, record.kind, token)) return undefined;
  const observationId = randomUUID();
  await insertLedgerMovement(client, event, observationId, event.occurredAt ?? event.receivedAt,
    event.msi ? bankPlanEvidence(record, row, event.msi as MsiPlan) : []);
  const originalDay = `${row.occurredOn}T12:00:00.000Z`;
  await appendLedgerObservation(client, { id: observationId, movementId: event.id, captureSource: record.kind,
    observedAt: event.receivedAt, reconciliationAt: originalDay, institution: event.institution,
    eventType: event.eventType, account: event.account, amount: { amountMinor: row.amountMinor, currency: 'MXN' },
    merchantRaw: row.merchantRaw, occurredAt: originalDay, source: record.source, parserVersion: event.parserVersion,
    parseWarnings: [], bankTransactionId: row.transactionId, rowNumber: row.rowNumber });
  await insertSourceClaim(client, { captureSource: record.kind, token, createdAt: event.ingestedAt,
    movementId: event.id, observationId, owner: record.owner, rowIdentity: row.identity });
  return readLedgerDetail(client, event.id);
});

export const linkBankEvidence = (input: {
  readonly record: BankImportRecord; readonly row: BankImportRow; readonly eventId: string;
  readonly appliedAt: string; readonly reason: string; readonly parserVersion: string;
  readonly account?: Readonly<Record<string,unknown>>;
}): Promise<boolean> => withSqlTransaction(async client => {
  const { record, row, eventId, appliedAt } = input;
  bankRowPosition(record, row);
  const token = bankClaimToken(row.identity);
  if (await readSourceClaim(client, record.kind, token)) return false;
  const credit = isBankCredit(row);
  if (credit) {
    const target = await readBankCredit(client, record.owner, eventId);
    const institution = record.kind.startsWith('amex_') ? 'american_express_mx' : 'santander_mx';
    if (!target || target.accountKind !== 'credit_card' || target.institution !== institution
      || target.accountLastFour !== record.accountLastFour
      || (target.postedOn !== row.occurredOn && target.postedOn !== row.purchaseOn)) return false;
    if (target.amountMinor !== Math.abs(row.amountMinor))
      throw new BankImportError('El importe bancario difiere del importe del abono registrado.');
    if ((await client.query('SELECT 1 FROM olbia.ledger_observations WHERE movement_id=$1 AND capture_source=$2',
      [eventId, record.kind])).rows.length) return false;
  } else {
    const target = await readLedgerDetail(client, eventId);
    if (!target || target.status === 'rejected') return false;
    if (row.kind !== 'msi' && !target.msi && hasManualMovementEvidence(target) && !movementAmountMatches(target, row))
      throw new BankImportError('El importe bancario difiere de la evidencia manual.');
  }
  const observationId = randomUUID(), at = `${row.occurredOn}T12:00:00.000Z`;
  await appendLedgerObservation(client, { id: observationId, movementId: eventId, captureSource: record.kind,
    observedAt: appliedAt, reconciliationAt: at, institution: record.kind.startsWith('amex_') ? 'american_express_mx' : 'santander_mx',
    eventType: credit ? 'bank_credit' : 'card_purchase', amount: { amountMinor: Math.abs(row.amountMinor), currency: 'MXN' }, merchantRaw: row.merchantRaw,
    ...(input.account ? {account:input.account} : {}),
    ...(!credit ? { occurredAt: at } : {}), source: record.source, parserVersion: input.parserVersion, parseWarnings: [],
    rowNumber: row.rowNumber, bankTransactionId: row.transactionId,
    ...(record.kind === 'amex_activity' ? { account: { institution: 'american_express_mx', lastFour: record.accountLastFour } } : {}) });
  await markMovementReconciled(client, eventId, appliedAt);
  if (!credit && record.kind === 'santander_csv') {
    reserveLedgerMutations(1);
    await client.query('UPDATE olbia.ledger_movements SET bank_transaction_id=$2 WHERE id=$1', [eventId, row.transactionId ?? row.identity]);
  }
  const reconciliation = { source: record.source, reconciledAt: appliedAt,
    ...(record.kind === 'santander_csv' ? { rowNumber: row.rowNumber, transactionId: row.transactionId } : {}) };
  await insertLedgerRevision(client, { id: randomUUID(), movementId: eventId, createdAt: appliedAt,
    changedBy: record.owner, reason: input.reason, changes: { reconciliation: { previous: null, next: reconciliation } } });
  await insertSourceClaim(client, { captureSource: record.kind, token, createdAt: appliedAt,
    movementId: eventId, observationId, owner: record.owner, rowIdentity: row.identity });
  return true;
});

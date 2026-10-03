import { createHash, randomUUID } from 'node:crypto';
import { withSqlTransaction } from '@finance/ledger/sql-runtime';
import { appendLedgerObservation, insertLedgerMovement, insertLedgerRevision, insertSourceClaim,
  markMovementReconciled, readLedgerDetail, readLedgerMovements, readSourceClaim,
  withLedgerMutationBudget, reserveLedgerMutations, LedgerMutationBudgetError,
  type BankRowEvidence } from '@finance/ledger/native-ledger';
import type { MsiPlan } from '@finance/domain';
import type { ObservedEventInput } from '@finance/ledger/native-ledger';
import { readerPool } from '../events/sql-reads.js';
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
export const bankLedgerEvents = () => readLedgerMovements(readerPool());
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
    'installmentIndex', 'installmentMonths', 'originalAmountMinor', 'occurrence', 'kind', 'credit'] as const)
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
}): Promise<boolean> => withSqlTransaction(async client => {
  const { record, row, eventId, appliedAt } = input;
  bankRowPosition(record, row);
  const token = bankClaimToken(row.identity);
  if (await readSourceClaim(client, record.kind, token)) return false;
  if (!await readLedgerDetail(client, eventId)) return false;
  const observationId = randomUUID(), at = `${row.occurredOn}T12:00:00.000Z`;
  await appendLedgerObservation(client, { id: observationId, movementId: eventId, captureSource: record.kind,
    observedAt: appliedAt, reconciliationAt: at, institution: record.kind === 'amex_statement' ? 'american_express_mx' : 'santander_mx',
    eventType: 'card_purchase', amount: { amountMinor: row.amountMinor, currency: 'MXN' }, merchantRaw: row.merchantRaw,
    occurredAt: at, source: record.source, parserVersion: input.parserVersion, parseWarnings: [],
    rowNumber: row.rowNumber, bankTransactionId: row.transactionId });
  await markMovementReconciled(client, eventId, appliedAt);
  if (record.kind === 'santander_csv') {
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

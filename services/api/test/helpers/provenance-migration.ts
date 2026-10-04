// Historical migration verifier fixture. Never imported by deployed code.
import { createHash } from 'node:crypto';
import type { ReadSqlClient } from '../../src/events/sql-reads.js';
import type { JsonObject } from '../../src/http/response.js';
import { samePublicResult } from '../../src/events/read-selection.js';
import { readBulkOperation } from '../../src/events/bulk-storage.js';

const iso = (value: unknown) => value == null ? undefined : new Date(value as string | Date).toISOString();
const nullable = (value: unknown) => value ?? null;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bankKinds = ['amex_statement', 'santander_statement', 'santander_csv'];
const claimIdentity = (source: JsonObject): { kind: string; token: string } => {
  const key = String(source.PK).slice('DEDUPE#'.length);
  for (const [prefix, kind] of [['apple_pay_shortcut:', 'apple_pay_shortcut'], ['MANUAL#', 'manual'],
    ['SANTANDER_CSV#', 'santander_csv'], ['AMEX_STATEMENT#', 'amex_statement'], ['SANTANDER_STATEMENT#', 'santander_statement']])
    if (key.startsWith(prefix)) return { kind, token: key.slice(prefix.length) };
  return { kind: 'email', token: key };
};
const originalSource = (row: JsonObject) => ({ ...row.source_metadata as JsonObject,
  ...(row.source_kind == null ? {} : { kind: row.source_kind }),
  ...(row.evidence_bucket == null ? {} : { bucket: row.evidence_bucket, key: row.evidence_key,
    sha256: row.evidence_sha256, contentType: row.evidence_content_type }),
});
const originalAccount = (row: JsonObject) => row.account_present ? {
  accountId: row.account_id ?? undefined, displayName: row.account_name ?? undefined,
  institution: row.account_institution ?? undefined, lastFour: row.account_last_four ?? undefined,
} : undefined;
const originalObservation = (row: JsonObject, warnings: JsonObject[]) => ({
  id: row.id, eventId: row.movement_id, captureSource: row.capture_source,
  observedAt: iso(row.observed_at), reconciliationAt: iso(row.reconciliation_at), institution: row.institution,
  eventType: row.event_type, account: originalAccount(row), amount: { amountMinor: Number(row.amount_minor), currency: row.currency },
  merchantRaw: row.merchant_raw, occurredAt: iso(row.occurred_at), source: originalSource(row), parserVersion: row.parser_version,
  parseWarnings: warnings.filter(w => w.observation_id === row.id).map(w => w.message),
  bankTransactionId: row.bank_transaction_id ?? undefined, rowNumber: row.csv_row_number ?? undefined, note: row.note ?? undefined,
});
const memberAssertion = (row: JsonObject) => ({ id: row.movement_id, merchantRaw: row.merchant_assertion,
  occurredAt: iso(row.occurred_at_assertion), status: row.status_assertion, amountMinor: Number(row.amount_minor_assertion),
  previousTags: row.previous_tags, nextTags: row.next_tags,
  previousCategoryId: row.previous_category_id, nextCategoryId: row.next_category_id });

const requiredRelations = ['source_claims_pkey', 'source_claims_movement_id_fkey', 'source_claims_observation_fk',
  'installment_evidence_candidates_pkey', 'installment_evidence_candidates_entry_fk',
  'installment_evidence_candidates_row_fk', 'ledger_bulk_operations_pkey',
  'ledger_bulk_members_pkey', 'ledger_bulk_members_movement_key'] as const;

/** Recovery assertions prove immutable history only. Current financial facts remain native SQL authority. */
export const verifyNativeLedgerProvenance = async (client: ReadSqlClient,
  readOperation = (owner: string, id: string) => readBulkOperation(owner, id, client)) => {
  const started = Date.now();
  const [observations, warnings, revisions, claims, plans, entries, candidates, bankRows, operations, members,
    frozenObservations, frozenRevisions, frozenClaims, frozenOperations, frozenParents, currentParents, constraints] = await Promise.all([
    client.query('SELECT * FROM olbia.ledger_observations ORDER BY movement_id,position'),
    client.query('SELECT * FROM olbia.ledger_observation_warnings ORDER BY observation_id,position'),
    client.query('SELECT * FROM olbia.ledger_revisions ORDER BY id'),
    client.query('SELECT * FROM olbia.source_claims ORDER BY capture_source,token'),
    client.query('SELECT * FROM olbia.installment_plans ORDER BY movement_id'),
    client.query('SELECT * FROM olbia.installment_entries ORDER BY movement_id,installment_index'),
    client.query('SELECT * FROM olbia.installment_evidence_candidates ORDER BY movement_id,installment_index,import_kind,content_sha256,row_position'),
    client.query(`SELECT r.*,h.evidence_bucket,h.evidence_key FROM olbia.bank_import_rows r JOIN olbia.bank_imports h
      ON h.kind=r.kind AND h.content_sha256=r.content_sha256`),
    client.query('SELECT * FROM olbia.ledger_bulk_operations ORDER BY id'),
    client.query('SELECT * FROM olbia.ledger_bulk_members ORDER BY operation_id,position'),
    client.query('SELECT payload FROM olbia.movement_observations'),
    client.query('SELECT payload FROM olbia.movement_revisions'),
    client.query("SELECT source_item FROM olbia.dedupe_claims WHERE source_pk NOT LIKE 'DEDUPE#CFDI_NOMINA#%'"),
    client.query('SELECT payload FROM olbia.bulk_edit_operations'),
    client.query('SELECT id FROM olbia.movements'),
    client.query('SELECT id,status,personal_amount_minor FROM olbia.ledger_movements'),
    client.query(`SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace
      AND conname=ANY($1::text[]) ORDER BY conname`, [[...requiredRelations]]),
  ]);
  let mismatches = 0, legacyObservationOmissions = 0, csvBackfills = 0, bulkReads = 0;
  const check = (a: unknown, b: unknown) => { mismatches += Number(!samePublicResult(a, b)); };
  check([...requiredRelations].sort().map(conname => ({ conname, convalidated: true })), constraints.rows);
  const originals = frozenObservations.rows.map(r => r.payload as JsonObject);
  const retainedClaims = frozenClaims.rows.map(r => {
    const source = r.source_item as JsonObject;
    return { ...claimIdentity(source), source };
  });
  for (const original of originals) {
    const row = observations.rows.find(r => r.id === original.id);
    check(original, row && originalObservation(row, warnings.rows));
    const ordered = originals.filter(r => r.eventId === original.eventId).sort((a, b) =>
      Date.parse(String(a.observedAt)) - Date.parse(String(b.observedAt)) || Buffer.compare(Buffer.from(String(a.id)), Buffer.from(String(b.id))));
    check(ordered.findIndex(r => r.id === original.id), row?.position);
  }
  for (const retained of frozenRevisions.rows) {
    const original = retained.payload as JsonObject, row = revisions.rows.find(r => r.id === original.id);
    check(original, row && { id: row.id, observedPurchaseId: row.movement_id, createdAt: iso(row.created_at),
      changedBy: row.changed_by, changes: row.changes, reason: row.reason ?? undefined,
      operationId: row.operation_id ?? undefined, source: row.source ?? undefined });
  }
  for (const retained of retainedClaims) {
    const { source: original, kind, token } = retained;
    const claim = claims.rows.find(c => c.capture_source === kind && c.token === token);
    check({ createdAt: iso(original.createdAt), owner: nullable(original.owner), rowIdentity: nullable(original.identity),
      fingerprint: nullable(original.fingerprint), reconciled: nullable(original.reconciled) }, claim && {
      createdAt: iso(claim.created_at), owner: claim.owner, rowIdentity: claim.row_identity,
      fingerprint: claim.fingerprint, reconciled: claim.reconciled });
    if (kind === 'santander_csv' && original.eventId == null) {
      // Only original captures participate: later appearances of the identity cannot change the one-time proof.
      const rows = bankRows.rows.filter(r => r.kind === kind && r.identity === original.identity);
      const matches = originals.filter(o => o.captureSource === kind && rows.some(r => {
        const source = o.source as JsonObject;
        return source.bucket === r.evidence_bucket && source.key === r.evidence_key && o.rowNumber === r.row_number
          && nullable(o.bankTransactionId) === r.bank_transaction_id && o.merchantRaw === r.merchant_raw
          && String(o.occurredAt).slice(0, 10) === String(r.occurred_on instanceof Date ? r.occurred_on.toISOString() : r.occurred_on).slice(0, 10);
      }));
      check(matches.length, 1);
      check({ outcome: 'linked', movement: matches[0]?.eventId, observation: matches[0]?.id, historical: null }, claim && {
        outcome: claim.outcome, movement: claim.movement_id, observation: claim.observation_id, historical: claim.historical_target_id });
      csvBackfills++;
    } else {
      const missing = original.eventId != null && !frozenParents.rows.some(r => r.id === original.eventId);
      check({ outcome: missing ? 'historical_missing' : original.eventId == null ? 'unresolved_suppression' : 'linked',
        movement: missing ? null : nullable(original.eventId), observation: nullable(original.observationId),
        historical: missing ? original.eventId : null }, claim && { outcome: claim.outcome,
        movement: claim.movement_id, observation: claim.observation_id, historical: claim.historical_target_id });
    }
  }
  for (const claim of claims.rows) {
    if (bankKinds.includes(String(claim.capture_source))) {
      check(true, typeof claim.row_identity === 'string' && hash(claim.row_identity) === claim.token
        && bankRows.rows.some(r => r.kind === claim.capture_source && r.identity === claim.row_identity));
    }
    if (claim.outcome === 'linked') {
      if (claim.observation_id != null) check(true, observations.rows.some(o => o.id === claim.observation_id
        && o.movement_id === claim.movement_id && o.capture_source === claim.capture_source));
      else {
        const retained = retainedClaims.find(r => r.kind === claim.capture_source && r.token === claim.token);
        check(true, bankKinds.includes(String(claim.capture_source)) && retained?.source.eventId === claim.movement_id
          && retained?.source.observationId == null);
        legacyObservationOmissions++;
      }
    } else if (['historical_missing', 'unresolved_suppression'].includes(String(claim.outcome))) {
      check(true, retainedClaims.some(r => r.kind === claim.capture_source && r.token === claim.token));
    }
  }
  const rowMatches = (reference: JsonObject, row: JsonObject) => reference.import_kind === row.kind
    && reference.content_sha256 === row.content_sha256 && reference.row_position === row.position;
  for (const plan of plans.rows) {
    const schedule = entries.rows.filter(e => e.movement_id === plan.movement_id);
    const parent = currentParents.rows.find(p => p.id === plan.movement_id);
    check(true, parent != null && parent.personal_amount_minor == null && parent.status !== 'pending_foreign');
    check(true, schedule.length === plan.months && schedule.every((e, i) => e.installment_index === i + 1));
  }
  for (const entry of entries.rows) {
    const choices = candidates.rows.filter(c => c.movement_id === entry.movement_id && c.installment_index === entry.installment_index);
    if (entry.evidence_origin === 'bank_row') {
      const row = bankRows.rows.find(r => rowMatches({ import_kind: entry.evidence_import_kind,
        content_sha256: entry.evidence_content_sha256, row_position: entry.evidence_row_position }, r));
      check(entry.evidence_identity, row?.identity); check(choices.length, 0);
    } else if (entry.evidence_origin === 'ambiguous_bank_row') {
      check(true, choices.length >= 2 && choices.every(c => bankRows.rows.some(r => rowMatches(c, r) && r.identity === entry.evidence_identity)));
    } else {
      check(choices.length, 0);
      check(true, entry.evidence_origin == null ? entry.evidence_identity == null
        : entry.evidence_origin === 'legacy_backfill' && /^backfill[:#_-]/i.test(String(entry.evidence_identity)));
    }
  }
  for (const operation of operations.rows) {
    const snapshots = members.rows.filter(m => m.operation_id === operation.id);
    check(true, snapshots.length > 0 && snapshots.every((m, i) => m.position === i));
    const expected = { operationId: operation.id, owner: operation.owner, status: operation.status,
      createdAt: iso(operation.created_at), expiresAt: Number(operation.expires_at), selection: operation.selection_assertion,
      change: operation.change_assertion, events: snapshots.map(memberAssertion),
      amountMinor: snapshots.reduce((sum, m) => sum + Number(m.amount_minor_assertion), 0),
      appliedAt: iso(operation.applied_at), undoneAt: iso(operation.undone_at) };
    check(expected, await readOperation(String(operation.owner), String(operation.id))); bulkReads++;
  }
  for (const retained of frozenOperations.rows) {
    const original = retained.payload as JsonObject, operation = operations.rows.find(o => o.id === original.operationId);
    const snapshots = members.rows.filter(m => m.operation_id === original.operationId);
    check({ owner: original.owner, createdAt: iso(original.createdAt), expiresAt: original.expiresAt,
      selection: original.selection, change: original.change, events: original.events, amountMinor: original.amountMinor }, operation && {
      owner: operation.owner, createdAt: iso(operation.created_at), expiresAt: Number(operation.expires_at),
      selection: operation.selection_assertion, change: operation.change_assertion, events: snapshots.map(memberAssertion),
      amountMinor: snapshots.reduce((sum, m) => sum + Number(m.amount_minor_assertion), 0) });
    if (original.appliedAt != null) check(iso(original.appliedAt), iso(operation?.applied_at));
    if (original.status === 'undone') check('undone', operation?.status);
  }
  for (const revision of revisions.rows.filter(r => r.operation_id != null))
    check(true, members.rows.some(m => m.operation_id === revision.operation_id && m.movement_id === revision.movement_id));
  return { observations: observations.rows.length, originalObservations: originals.length,
    originalRevisions: frozenRevisions.rows.length, claims: claims.rows.length, originalClaims: retainedClaims.length,
    legacyObservationOmissions, csvBackfills, plans: plans.rows.length, installments: entries.rows.length,
    evidenceCandidates: candidates.rows.length, operations: operations.rows.length, members: members.rows.length,
    bulkReads, originalOperations: frozenOperations.rows.length,
    validatedRelations: constraints.rows.filter(r => r.convalidated === true).length, mismatches, elapsedMs: Date.now() - started };
};

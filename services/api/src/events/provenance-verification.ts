import { createHash } from 'node:crypto';
import type { ReadSqlClient } from './sql-reads.js';
import type { JsonObject } from '../http/response.js';
import { samePublicResult } from './read-selection.js';
import { readBulkOperation } from './bulk-storage.js';

const iso = (value: unknown) => value == null ? undefined : new Date(value as string | Date).toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bankKinds = ['amex_statement', 'santander_statement', 'santander_csv'];
const memberAssertion = (row: JsonObject) => ({ id: row.movement_id, merchantRaw: row.merchant_assertion,
  occurredAt: iso(row.occurred_at_assertion), status: row.status_assertion, amountMinor: Number(row.amount_minor_assertion),
  previousTags: row.previous_tags, nextTags: row.next_tags,
  previousCategoryId: row.previous_category_id, nextCategoryId: row.next_category_id });

const requiredRelations = ['source_claims_pkey', 'source_claims_movement_id_fkey', 'source_claims_observation_fk',
  'installment_evidence_candidates_pkey', 'installment_evidence_candidates_entry_fk',
  'installment_evidence_candidates_row_fk', 'ledger_bulk_operations_pkey',
  'ledger_bulk_members_pkey', 'ledger_bulk_members_movement_key'] as const;

/** Independent current relationships, original capture identities and historical bulk assertions. */
export const verifyNativeLedgerProvenance = async (client: ReadSqlClient,
  readOperation = (owner: string, id: string) => readBulkOperation(owner, id, client)) => {
  const started = Date.now();
  const [observations, warnings, revisions, claims, plans, entries, candidates, bankRows, operations, members,
    currentParents, constraints] = await Promise.all([
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
    client.query('SELECT id,status,personal_amount_minor FROM olbia.ledger_movements'),
    client.query(`SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace
      AND conname=ANY($1::text[]) ORDER BY conname`, [[...requiredRelations]]),
  ]);
  let mismatches = 0, linkedClaimsWithoutObservation = 0, bankClaims = 0, bulkReads = 0;
  const check = (a: unknown, b: unknown) => { mismatches += Number(!samePublicResult(a, b)); };
  check([...requiredRelations].sort().map(conname => ({ conname, convalidated: true })), constraints.rows);
  const parentIds = new Set(currentParents.rows.map(row => row.id));
  for (const observation of observations.rows) check(true, parentIds.has(observation.movement_id));
  for (const movement of currentParents.rows) {
    const captures = observations.rows.filter(row => row.movement_id === movement.id);
    check(true, captures.length > 0 && captures.every((row, position) => row.position === position));
  }
  for (const warning of warnings.rows) check(true, observations.rows.some(row => row.id === warning.observation_id));
  for (const revision of revisions.rows) check(true, parentIds.has(revision.movement_id));
  for (const claim of claims.rows) {
    if (bankKinds.includes(String(claim.capture_source))) {
      bankClaims++;
      check(true, typeof claim.row_identity === 'string' && hash(claim.row_identity) === claim.token
        && bankRows.rows.some(r => r.kind === claim.capture_source && r.identity === claim.row_identity));
    }
    if (claim.outcome === 'linked') {
      check(true, parentIds.has(claim.movement_id));
      if (claim.observation_id != null) check(true, observations.rows.some(o => o.id === claim.observation_id
        && o.movement_id === claim.movement_id && o.capture_source === claim.capture_source));
      else {
        // Historically absent observation identities remain explicit; do not fabricate a capture.
        check(true, bankKinds.includes(String(claim.capture_source)));
        linkedClaimsWithoutObservation++;
      }
      check(null, claim.historical_target_id);
    } else if (claim.outcome === 'historical_missing') {
      check(true, claim.movement_id == null && claim.observation_id == null
        && typeof claim.historical_target_id === 'string' && claim.historical_target_id.length > 0);
    } else if (['unresolved_suppression', 'suppressed'].includes(String(claim.outcome))) {
      check(true, claim.movement_id == null && claim.observation_id == null && claim.historical_target_id == null);
    } else check(true, false);
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
  for (const revision of revisions.rows.filter(r => r.operation_id != null))
    check(true, members.rows.some(m => m.operation_id === revision.operation_id && m.movement_id === revision.movement_id));
  return { observations: observations.rows.length, revisions: revisions.rows.length, claims: claims.rows.length,
    linkedClaimsWithoutObservation, bankClaims, plans: plans.rows.length, installments: entries.rows.length,
    evidenceCandidates: candidates.rows.length, operations: operations.rows.length, members: members.rows.length, bulkReads,
    validatedRelations: constraints.rows.filter(r => r.convalidated === true).length, mismatches, elapsedMs: Date.now() - started };
};

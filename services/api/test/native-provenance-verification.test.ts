import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeFixture } from './fixtures/native-ledger.js';
import { readLedgerDetail } from '../../ledger/src/dsql/ledger-reads.js';
import { appendLedgerObservation, insertLedgerRevision, insertSourceClaim } from '../../ledger/src/dsql/ledger-writes.js';
import { currentStoreTransaction } from '../../ledger/src/dsql/store.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import type { JsonObject } from '../src/http/response.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let verify: typeof import('../src/events/provenance-verification.js')['verifyNativeLedgerProvenance'];
let bulk: typeof import('../src/events/bulk-storage.js');
const at = '2026-10-02T12:00:00.123Z';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
beforeAll(async () => {
  vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  fixture = await nativeFixture();
  harness.pool = fixture.pool;
  verify = (await import('../src/events/provenance-verification.js')).verifyNativeLedgerProvenance;
  bulk = await import('../src/events/bulk-storage.js');
}, 30_000);
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql.exec('TRUNCATE olbia.movements,olbia.movement_observations,olbia.movement_revisions,olbia.dedupe_claims,olbia.bulk_edit_operations');
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
const freeze = async (table: 'movements' | 'movement_observations' | 'movement_revisions' | 'bulk_edit_operations', id: string, payload: unknown) =>
  fixture.sql.query(`INSERT INTO olbia.${table} (source_pk,source_sk,row_id,payload${table === 'movements' ? ',id' : ''})
    VALUES ($1,$2,$3,$4${table === 'movements' ? ',$3' : ''})`, [`FROZEN#${id}`, 'FROZEN', id, JSON.stringify(payload)]);
const freezeClaim = async (prefix: string, token: string, fields: JsonObject = {}) => {
  const source = { PK: `DEDUPE#${prefix}${token}`, SK: 'CLAIM', entityType: 'dedupe_claim', createdAt: at, ...fields };
  await fixture.sql.query(`INSERT INTO olbia.dedupe_claims (source_pk,source_sk,row_id,source_item)
    VALUES ($1,'CLAIM','CLAIM',$2)`, [source.PK, JSON.stringify(source)]);
};
const bankRow = async (sha: string, identity: string, kind = 'amex_statement') => {
  await fixture.sql.query(`INSERT INTO olbia.bank_imports
    (kind,content_sha256,owner,status,created_at,account_last_four,product,period_start,period_end,evidence_bucket,evidence_key,evidence_content_type)
    VALUES ($1,$2,'owner','previewed',$3,'1234','Card','2026-10-01','2026-10-31','evidence',$2,'application/pdf')`, [kind, sha, at]);
  await fixture.sql.query(`INSERT INTO olbia.bank_import_rows
    (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,row_kind,row_number)
    VALUES ($1,$2,0,$3,'2026-10-02','Original shop',10000,'new','purchase',1)`, [kind, sha, identity]);
};

describe('independent ledger provenance and immutable recovery assertions', () => {
  it('allows current edits and new captures while detecting altered original observations, warnings and revisions', async () => {
    const id = await fixture.create({ parseWarnings: ['Original warning'] });
    const original = (await readLedgerDetail(fixture.pool, id))!.observations as JsonObject[];
    await freeze('movements', id, {}); await freeze('movement_observations', String(original[0].id), original[0]);
    await insertLedgerRevision(fixture.pool, { id: 'original-revision', movementId: id, createdAt: at, changedBy: 'owner',
      changes: { personalAmountMinor: { previous: null, next: 0 } } });
    await freeze('movement_revisions', 'original-revision', ((await readLedgerDetail(fixture.pool, id))!.revisions as JsonObject[])[0]);
    await fixture.sql.query('UPDATE olbia.ledger_movements SET merchant_raw=$2,personal_amount_minor=0 WHERE id=$1', [id, 'Current name']);
    await appendLedgerObservation(fixture.pool, { id: randomUUID(), movementId: id, captureSource: 'apple_pay_shortcut',
      observedAt: at, reconciliationAt: at, institution: 'santander_mx', eventType: 'card_purchase',
      amount: { amountMinor: 10000, currency: 'MXN' }, merchantRaw: 'Another capture',
      source: { kind: 'apple_pay_shortcut', requestId: 'new' }, parserVersion: 'shortcut', parseWarnings: [] });
    const before = await fixture.snapshot();
    expect(await verify(fixture.pool)).toMatchObject({ observations: 2, originalObservations: 1, originalRevisions: 1, mismatches: 0 });
    expect(await fixture.snapshot()).toEqual(before);
    await fixture.sql.query('UPDATE olbia.ledger_observation_warnings SET message=$1', ['Wrong original warning']);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('UPDATE olbia.ledger_observation_warnings SET message=$1', ['Original warning']);
    await fixture.sql.query('UPDATE olbia.ledger_revisions SET changes=$1', [JSON.stringify({})]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('UPDATE olbia.ledger_observations SET amount_minor=1 WHERE id=$1', [original[0].id]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(1);
  });

  it('preserves proven historical omissions and suppression, but rejects invented missing links and cross-kind claims', async () => {
    const id = await fixture.create(), observation = ((await readLedgerDetail(fixture.pool, id))!.observations as JsonObject[])[0];
    await freeze('movements', id, {});
    await bankRow('a'.repeat(64), 'old-bank-row');
    await bankRow('b'.repeat(64), 'missing-bank-row');
    await freezeClaim('AMEX_STATEMENT#', digest('old-bank-row'), { identity: 'old-bank-row', eventId: id });
    await fixture.sql.query(`INSERT INTO olbia.source_claims
      (capture_source,token,created_at,row_identity,outcome,movement_id) VALUES ('amex_statement',$1,$2,'old-bank-row','linked',$3)`,
    [digest('old-bank-row'), at, id]);
    const missing = randomUUID();
    await freezeClaim('AMEX_STATEMENT#', digest('missing-bank-row'), { identity: 'missing-bank-row', eventId: missing });
    await fixture.sql.query(`INSERT INTO olbia.source_claims
      (capture_source,token,created_at,row_identity,outcome,historical_target_id)
      VALUES ('amex_statement',$1,$2,'missing-bank-row','historical_missing',$3)`, [digest('missing-bank-row'), at, missing]);
    await freezeClaim('', 'unresolved');
    await fixture.sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome)
      VALUES ('email','unresolved',$1,'unresolved_suppression'),('email','ignored',$1,'suppressed')`, [at]);
    expect(await verify(fixture.pool)).toMatchObject({ claims: 4, originalClaims: 3, legacyObservationOmissions: 1, mismatches: 0 });
    await fixture.sql.query(`UPDATE olbia.source_claims SET outcome='suppressed' WHERE token='unresolved'`);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query(`UPDATE olbia.source_claims SET outcome='unresolved_suppression' WHERE token='unresolved'`);
    await insertSourceClaim(fixture.pool, { captureSource: 'manual', token: 'wrong-kind', createdAt: at, movementId: id,
      observationId: String(observation.id) });
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query("DELETE FROM olbia.source_claims WHERE token='wrong-kind'");
    await fixture.sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,row_identity,outcome,movement_id)
      VALUES ('amex_statement','invented',$1,'old-bank-row','linked',$2)`, [at, id]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
  });

  it('proves CSV backfills from the original capture without interpreting later captures as new ambiguity', async () => {
    const sha = 'c'.repeat(64), identity = 'csv-original';
    await bankRow(sha, identity, 'santander_csv');
    const id = await fixture.create({ source: { bucket: 'evidence', key: sha, sha256: sha, contentType: 'text/csv' } });
    const observation = ((await readLedgerDetail(fixture.pool, id))!.observations as JsonObject[])[0];
    await fixture.sql.query("UPDATE olbia.ledger_observations SET capture_source='santander_csv',csv_row_number=1 WHERE id=$1", [observation.id]);
    const original = ((await readLedgerDetail(fixture.pool, id))!.observations as JsonObject[])[0];
    await freeze('movements', id, {}); await freeze('movement_observations', String(original.id), original);
    await freezeClaim('SANTANDER_CSV#', digest(identity), { identity });
    await insertSourceClaim(fixture.pool, { captureSource: 'santander_csv', token: digest(identity), createdAt: at,
      movementId: id, observationId: String(original.id), rowIdentity: identity });
    const later = randomUUID();
    await appendLedgerObservation(fixture.pool, { id: later, movementId: id, captureSource: 'santander_csv', observedAt: at,
      reconciliationAt: at, occurredAt: at, institution: 'santander_mx', eventType: 'card_purchase',
      amount: { amountMinor: 10000, currency: 'MXN' }, merchantRaw: 'Original shop', rowNumber: 1,
      source: { bucket: 'evidence', key: sha, sha256: sha, contentType: 'text/csv' }, parserVersion: 'new', parseWarnings: [] });
    expect(await verify(fixture.pool)).toMatchObject({ csvBackfills: 1, mismatches: 0 });
    await fixture.sql.query('UPDATE olbia.source_claims SET observation_id=$1', [later]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
  });

  it('detects wrong exact MSI identity, lost ambiguity candidates, invalid backfills and incomplete schedules', async () => {
    await bankRow('a'.repeat(64), 'repeated'); await bankRow('b'.repeat(64), 'repeated'); await bankRow('c'.repeat(64), 'unrelated');
    const id = await fixture.create({ msi: { months: 2, principalMinor: 20000, cuotaMinor: 10000, origin: 'manual', status: 'active',
      installments: [{ index: 1, month: '2026-10', amountMinor: 10000, status: 'spent' },
        { index: 2, month: '2026-11', amountMinor: 10000, status: 'committed' }] } });
    await fixture.sql.query(`UPDATE olbia.installment_entries SET confirmed_at=$2,evidence_identity='repeated',
      evidence_origin='ambiguous_bank_row' WHERE movement_id=$1 AND installment_index=1`, [id, at]);
    for (const sha of ['a', 'b']) await fixture.sql.query(`INSERT INTO olbia.installment_evidence_candidates
      VALUES ($1,1,'amex_statement',$2,0)`, [id, sha.repeat(64)]);
    expect((await verify(fixture.pool)).mismatches).toBe(0);
    await fixture.sql.query('DELETE FROM olbia.installment_evidence_candidates WHERE content_sha256=$1', ['b'.repeat(64)]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('DELETE FROM olbia.installment_evidence_candidates');
    await fixture.sql.query(`UPDATE olbia.installment_entries SET evidence_origin='bank_row',evidence_import_kind='amex_statement',
      evidence_content_sha256=$2,evidence_row_position=0 WHERE movement_id=$1 AND installment_index=1`, [id, 'c'.repeat(64)]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query(`UPDATE olbia.installment_entries SET evidence_origin='legacy_backfill',evidence_import_kind=NULL,
      evidence_content_sha256=NULL,evidence_row_position=NULL WHERE movement_id=$1 AND installment_index=1`, [id]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query("UPDATE olbia.installment_entries SET evidence_identity='backfill:original' WHERE installment_index=1");
    expect((await verify(fixture.pool)).mismatches).toBe(0);
    await fixture.sql.query('UPDATE olbia.ledger_movements SET personal_amount_minor=0 WHERE id=$1', [id]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('UPDATE olbia.ledger_movements SET personal_amount_minor=NULL WHERE id=$1', [id]);
    await fixture.sql.query('DELETE FROM olbia.installment_entries WHERE installment_index=2');
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
  });

  it('preserves frozen bulk facts after undo/current edits and detects lost members, reader history and revision membership', async () => {
    const id = await fixture.create(), other = await fixture.create();
    const operationId = randomUUID();
    const proposal = { operationId, owner: 'owner', status: 'pending' as const, createdAt: at, expiresAt: 1791000000,
      selection: { fromDay: '2026-10-01', toDay: '2026-10-31', statuses: ['accepted'] as const }, change: { addTags: ['audit'] },
      events: [{ id, merchantRaw: 'Frozen shop', status: 'accepted', amountMinor: 10000, previousTags: [], nextTags: ['audit'],
        previousCategoryId: 'historical-category', nextCategoryId: null }], amountMinor: 10000 };
    await fixture.run(() => bulk.insertBulkOperation(proposal));
    await fixture.run(() => bulk.transitionBulkOperation('owner', operationId, 'apply', at));
    const original = await bulk.readBulkOperation('owner', operationId, fixture.pool);
    await freeze('bulk_edit_operations', operationId, original);
    await fixture.run(() => bulk.transitionBulkOperation('owner', operationId, 'undo', '2026-10-03T12:00:00.123Z'));
    await fixture.sql.query('UPDATE olbia.ledger_movements SET merchant_raw=$2,personal_amount_minor=0 WHERE id=$1', [id, 'Changed']);
    await insertLedgerRevision(fixture.pool, { id: 'bulk-audit', movementId: id, operationId, createdAt: at,
      changedBy: 'owner', changes: { tags: { previous: [], next: ['audit'] } } });
    expect(await verify(fixture.pool)).toMatchObject({ operations: 1, members: 1, bulkReads: 1, originalOperations: 1, mismatches: 0 });
    expect((await verify(fixture.pool, async () => ({ ...original!, events: [] }))).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('UPDATE olbia.ledger_bulk_members SET merchant_assertion=$1', ['Lost history']);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
    await fixture.sql.query('UPDATE olbia.ledger_bulk_members SET merchant_assertion=$1', ['Frozen shop']);
    await fixture.sql.query('UPDATE olbia.ledger_revisions SET movement_id=$1', [other]);
    expect((await verify(fixture.pool)).mismatches).toBeGreaterThan(0);
  });

  it('releases the provenance snapshot before object IO and publishes aggregate counts without source assertions', async () => {
    vi.stubEnv('AGENT_OWNER_SUB', 'owner');
    await fixture.create();
    const evidence = await import('../src/events/evidence-verification.js');
    const planning = await import('../src/months/read-verification.js');
    const wealth = await import('../src/wealth/read-verification.js');
    const domain = await import('../src/categories/read-verification.js');
    const operational = await import('../src/operational/verification.js');
    for (const [module, method] of [[planning, 'verifyPlanningReads'], [wealth, 'verifyWealthReads'],
      [domain, 'verifyDomainReads'], [operational, 'verifyOperationalReads']] as const)
      vi.spyOn(module as never, method).mockResolvedValue({ mismatches: 0, elapsedMs: 1 } as never);
    const external = vi.spyOn(evidence, 'verifyLedgerEvidence').mockImplementation(async assertions => {
      expect(currentStoreTransaction()).toBeUndefined();
      expect(assertions).toHaveLength(1);
      return { captures: 1, inlineCaptures: 0, uniqueObjects: 1, evidenceFiles: 1, conflictingObjects: 0, mismatches: 0, elapsedMs: 1 };
    });
    const { verifyLedgerReads } = await import('../src/events/read-verification.js');
    const before = await fixture.snapshot();
    const outside = vi.spyOn(fixture.pool, 'query').mockRejectedValue(new Error('Read escaped snapshot'));
    const result = await verifyLedgerReads();
    expect(external).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ verified: true, mismatches: 0, provenance: { observations: 1, mismatches: 0 },
      evidence: { evidenceFiles: 1, mismatches: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/evidenceAssertions|evidence_bucket|evidence_key|source_metadata|merchantRaw/);
    expect(outside).not.toHaveBeenCalled(); outside.mockRestore();
    expect(await fixture.snapshot()).toEqual(before);
    external.mockResolvedValue({ captures: 1, inlineCaptures: 0, uniqueObjects: 1, evidenceFiles: 1,
      conflictingObjects: 0, mismatches: 1, elapsedMs: 1 });
    expect(await verifyLedgerReads()).toMatchObject({ verified: false, mismatches: 1 });
  });
});

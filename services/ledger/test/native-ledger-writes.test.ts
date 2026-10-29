import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildMsiSchedule, cancelRemainingInstallments, markInstallmentSpent, replaceMsiSchedule } from '@finance/domain';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import { runSqlTransaction } from '../src/dsql/sql-runtime.js';
import { saveNativeCapture } from '../src/dsql/ledger-capture.js';
import { readLedgerDetail } from '../src/dsql/ledger-reads.js';
import {
  confirmManualPlanBankTerms, insertLedgerRevision, InvalidLedgerWriteError, LedgerPreconditionError, replaceInstallmentPlan,
  replaceMovementTags, setMovementCategory, setMovementPersonalAmount, setMovementStatus,
  type ManualPlanBankTermsExpected,
} from '../src/dsql/ledger-writes.js';
import { LedgerMutationBudgetError, reserveLedgerMutations, withLedgerMutationBudget } from '../src/dsql/ledger-budget.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';

let sql: PGlite;
let pool: SqlClient & TransactionPool;
const at = '2026-10-02T12:00:00.123Z';
const kind = 'amex_statement';
const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const schedule = () => buildMsiSchedule({ principalMinor: 10000, months: 3, startMonth: '2026-10', origin: 'manual' });
const create = (status = 'accepted', currency = 'MXN') => runSqlTransaction(pool, client => saveNativeCapture(client, {
  token: randomUUID(), captureSource: 'email', reconciliationAt: at,
  event: { id: randomUUID(), institution: 'american_express_mx', eventType: 'card_purchase', status,
    amount: { amountMinor: 10000, currency }, merchantRaw: randomUUID(), receivedAt: at, ingestedAt: at,
    source: { bucket: 'evidence', key: randomUUID(), sha256: hash, contentType: 'message/rfc822' },
    parserVersion: 'original', parseWarnings: ['Original warning'] },
}));
const snapshot = async () => Object.fromEntries(await Promise.all(NATIVE_LEDGER_TABLES.map(async table =>
  [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2`)).rows])));
const seedImport = async (contentHash = hash) => {
  await sql.query(`INSERT INTO olbia.bank_imports
    (kind,content_sha256,owner,status,created_at,evidence_bucket,evidence_key,evidence_content_type)
    VALUES ($1,$2,'owner','failed',$3,'evidence',$4,'application/pdf')`, [kind, contentHash, at, `${contentHash}.pdf`]);
  await sql.query(`INSERT INTO olbia.bank_import_rows
    (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,row_kind)
    VALUES ($1,$2,0,'confirmed-row','2026-10-02','Original',3333,'matched','msi')`, [kind, contentHash]);
};
const manualTerms:ManualPlanBankTermsExpected={principalMinor:10000,cuotaMinor:3333,months:3,
  startMonth:'2026-10',occurredAt:at,accountLastFour:null};
const bankTerms={principalMinor:10001,account:{accountId:'american_express_mx:1007',displayName:'American Express · 1007',
  institution:'american_express_mx',lastFour:'1007'},bankTransactionId:'printed-bank-reference',reconciledAt:'2026-10-08T12:00:00.000Z'};
const createManualPlan=()=>runSqlTransaction(pool,async client=>{
  const capture=await saveNativeCapture(client,{token:randomUUID(),captureSource:'manual',reconciliationAt:at,
    event:{id:randomUUID(),institution:'american_express_mx',eventType:'card_purchase',status:'accepted',
      amount:{amountMinor:10000,currency:'MXN'},merchantRaw:'Nombre personal de la compra',occurredAt:at,
      account:{accountId:'american_express_mx:manual',displayName:'American Express (manual)',institution:'american_express_mx'},
      receivedAt:at,ingestedAt:at,categoryId:'shopping',tags:['compra:objeto'],
      source:{bucket:'evidence',key:randomUUID(),sha256:hash,contentType:'application/json',kind:'manual_entry'},
      parserVersion:'manual-entry-v1',parseWarnings:[]}});
  await replaceInstallmentPlan(client,capture.eventId,schedule());
  return capture;
});
beforeAll(async () => {
  sql = new PGlite();
  for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_LEDGER_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  pool = { query: (s, v) => sql.query<Record<string, unknown>>(s, v),
    transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) };
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts', 'bank_imports', 'bank_import_rows', 'bank_import_candidates'].map(t => `olbia.${t}`).join(',')}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

describe('native financial edits and MSI provenance', () => {
  it('changes category, normalized tags, personal zero and status with ordered native history and immutable evidence', async () => {
    const { eventId } = await create();
    const original = (await readLedgerDetail(pool, eventId))!.observations;
    await runSqlTransaction(pool, async client => {
      await setMovementCategory(client, eventId, 'shopping');
      await replaceMovementTags(client, eventId, [' Travel ', 'travel', 'SHARED']);
      await setMovementPersonalAmount(client, eventId, 0);
      await setMovementStatus(client, eventId, 'accepted', []);
      await insertLedgerRevision(client, { id: 'deterministic-audit-id', movementId: eventId, createdAt: at,
        changedBy: 'owner', reason: 'Explicit edit', changes: { personalAmountMinor: { previous: null, next: 0 } } });
    });
    const detail = await readLedgerDetail(pool, eventId);
    expect(detail).toMatchObject({ categoryId: 'shopping', tags: ['shared', 'travel'], personalAmountMinor: 0,
      parseWarnings: [], revisions: [{ id: 'deterministic-audit-id', changes: { personalAmountMinor: { previous: null, next: 0 } } }] });
    expect(detail!.observations).toEqual(original);
    await runSqlTransaction(pool, async client => {
      await setMovementCategory(client, eventId, null);
      await replaceMovementTags(client, eventId, []);
      await setMovementPersonalAmount(client, eventId, undefined);
      await setMovementStatus(client, eventId, 'rejected');
    });
    expect(await readLedgerDetail(pool, eventId)).toMatchObject({ status: 'rejected', tags: [] });
    expect(await readLedgerDetail(pool, eventId)).not.toHaveProperty('personalAmountMinor');
    expect((await readLedgerDetail(pool, eventId))!.observations).toEqual(original);
  });

  it('rolls back financial changes when an unknown category or duplicate audit identity fails', async () => {
    const { eventId } = await create();
    const before = await snapshot();
    await expect(runSqlTransaction(pool, async client => {
      await replaceMovementTags(client, eventId, ['temporary']);
      await setMovementCategory(client, eventId, 'missing-category');
    })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const revision = { id: 'audit', movementId: eventId, createdAt: at, changedBy: 'owner', changes: {} };
    await runSqlTransaction(pool, client => insertLedgerRevision(client, revision));
    const withRevision = await snapshot();
    await expect(runSqlTransaction(pool, async client => {
      await setMovementPersonalAmount(client, eventId, 0);
      await insertLedgerRevision(client, revision);
    })).rejects.toThrow();
    expect(await snapshot()).toEqual(withRevision);
  });

  it('rejects invalid personal money and incompatible MSI or pending foreign edits without losing zero/absence', async () => {
    const { eventId } = await create();
    for (const value of [-1, 10001, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runSqlTransaction(pool, client => setMovementPersonalAmount(client, eventId, value))).rejects.toThrow();
    }
    await runSqlTransaction(pool, client => setMovementPersonalAmount(client, eventId, 0));
    await expect(runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, schedule())))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    await runSqlTransaction(pool, async client => {
      await setMovementPersonalAmount(client, eventId, undefined);
      await replaceInstallmentPlan(client, eventId, schedule());
    });
    await expect(runSqlTransaction(pool, client => setMovementPersonalAmount(client, eventId, 0)))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    const foreign = await create('pending_foreign', 'USD');
    await expect(runSqlTransaction(pool, client => setMovementStatus(client, foreign.eventId, 'accepted')))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    await expect(runSqlTransaction(pool, client => replaceInstallmentPlan(client, foreign.eventId, schedule())))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    await expect(runSqlTransaction(pool, client => setMovementPersonalAmount(client, foreign.eventId, 0)))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    await runSqlTransaction(pool, client => setMovementStatus(client, foreign.eventId, 'rejected'));
  });

  it('requires the exact bank capture coordinates for a new confirmation and retains that relation when the schedule changes', async () => {
    const { eventId } = await create();
    await seedImport();
    const plan = markInstallmentSpent(schedule(), 1, { amountMinor: 3333, occurredOn: '2026-10-02',
      evidenceObservationId: 'confirmed-row', confirmedAt: at });
    await expect(runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, plan)))
      .rejects.toBeInstanceOf(InvalidLedgerWriteError);
    for (const evidence of [
      { installmentIndex: 1, kind, contentSha256: otherHash, rowPosition: 0 },
      { installmentIndex: 1, kind, contentSha256: hash, rowPosition: 1 },
    ] as const) {
      await expect(runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, plan, [evidence])))
        .rejects.toBeInstanceOf(InvalidLedgerWriteError);
    }
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, plan, [
      { installmentIndex: 1, kind, contentSha256: hash, rowPosition: 0 },
    ]));
    const changed = replaceMsiSchedule(plan, { principalMinor: 10000, months: 4, startMonth: '2026-09', origin: 'manual' });
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, changed));
    expect(await readLedgerDetail(pool, eventId)).toMatchObject({ msi: JSON.parse(JSON.stringify(changed)) });
    expect((await sql.query('SELECT * FROM olbia.installment_entries WHERE movement_id=$1 AND installment_index=1', [eventId])).rows[0])
      .toMatchObject({ confirmed_at: new Date(at), evidence_identity: 'confirmed-row', evidence_origin: 'bank_row',
        evidence_import_kind: kind, evidence_content_sha256: hash, evidence_row_position: 0, month: '2026-09' });
    await expect(sql.query('DELETE FROM olbia.bank_import_rows WHERE content_sha256=$1', [hash])).rejects.toThrow();
  });

  it('preserves ambiguous candidate captures and legacy backfill evidence when cancelling or moving terminal installments', async () => {
    const { eventId } = await create();
    await seedImport(); await seedImport(otherHash);
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, schedule()));
    await sql.query(`UPDATE olbia.installment_entries SET status='spent',confirmed_at=$2,evidence_identity='confirmed-row',
      evidence_origin='ambiguous_bank_row' WHERE movement_id=$1 AND installment_index=1`, [eventId, at]);
    await sql.query(`UPDATE olbia.installment_entries SET status='spent',confirmed_at=$2,evidence_identity='backfill:original',
      evidence_origin='legacy_backfill' WHERE movement_id=$1 AND installment_index=2`, [eventId, at]);
    for (const contentHash of [hash, otherHash]) await sql.query('INSERT INTO olbia.installment_evidence_candidates VALUES ($1,1,$2,$3,0)',
      [eventId, kind, contentHash]);
    const detail = await readLedgerDetail(pool, eventId);
    const plan = detail!.msi as ReturnType<typeof schedule>;
    const cancelled = cancelRemainingInstallments(plan);
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, cancelled));
    expect(await readLedgerDetail(pool, eventId)).toMatchObject({ msi: JSON.parse(JSON.stringify(cancelled)) });
    expect((await sql.query('SELECT content_sha256 FROM olbia.installment_evidence_candidates ORDER BY content_sha256')).rows)
      .toEqual([{ content_sha256: hash }, { content_sha256: otherHash }]);
    // A changed schedule can move a terminal month to another position; its evidence remains the same.
    const moved = { ...cancelled, installments: cancelled.installments.map((item, index) =>
      ({ ...cancelled.installments[(index + 1) % 3], index: item.index, month: item.month })) };
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, moved));
    expect((await sql.query('SELECT installment_index FROM olbia.installment_evidence_candidates')).rows)
      .toEqual([{ installment_index: 3 }, { installment_index: 3 }]);
    const before = await snapshot();
    const tampered = { ...moved, installments: moved.installments.map(item => item.evidenceObservationId
      ? { ...item, confirmedAt: '2026-10-02T12:00:00.124Z' } : item) };
    await expect(runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, tampered)))
      .rejects.toBeInstanceOf(InvalidLedgerWriteError);
    expect(await snapshot()).toEqual(before);
  });

  it('restores the whole plan and evidence when replacement fails after deleting the previous rows', async () => {
    const { eventId } = await create();
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, schedule()));
    const before = await snapshot();
    let deleted = false;
    await expect(runSqlTransaction(pool, client => replaceInstallmentPlan({ query: async (statement, values) => {
      if (statement.startsWith('INSERT INTO olbia.installment_plans')) {
        deleted = !(await client.query('SELECT * FROM olbia.installment_plans')).rows.length;
        throw new Error('Interrupted schedule replacement');
      }
      return client.query(statement, values);
    } }, eventId, schedule()))).rejects.toThrow('Interrupted schedule replacement');
    expect(deleted).toBe(true); expect(await snapshot()).toEqual(before);
    await runSqlTransaction(pool, client => replaceInstallmentPlan(client, eventId, undefined));
    expect((await readLedgerDetail(pool, eventId))!.msi).toBeUndefined();
  });
});

describe('manual MSI bank term confirmation',()=>{
  it('updates only current principal/account/reconciliation while preserving the original manual evidence and context',async()=>{
    const {eventId}=await createManualPlan();
    const before=(await readLedgerDetail(pool,eventId))!;
    const originalRows=await snapshot();
    await runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,manualTerms,bankTerms));
    const after=(await readLedgerDetail(pool,eventId))!;
    expect(after).toMatchObject({amount:{amountMinor:10001,currency:'MXN'},account:bankTerms.account,
      bankTransactionId:bankTerms.bankTransactionId,reconciledAt:bankTerms.reconciledAt,
      merchantRaw:before.merchantRaw,occurredAt:at,status:'accepted',categoryId:'shopping',tags:['compra:objeto']});
    expect(after.observations).toEqual(before.observations);
    expect(after.msi).toEqual(before.msi);
    expect(after.revisions).toEqual(before.revisions);
    const updatedRows=await snapshot();
    for(const table of NATIVE_LEDGER_TABLES.filter(table=>table!=='ledger_movements'))
      expect(updatedRows[table],table).toEqual(originalRows[table]);
  });

  it('retains needs_review and accepts a matching known card without clearing a previous bank reference',async()=>{
    const {eventId}=await createManualPlan();
    await sql.query(`UPDATE olbia.ledger_movements SET status='needs_review',account_last_four='1007',
      bank_transaction_id='retained-reference' WHERE id=$1`,[eventId]);
    const {bankTransactionId:_reference,...withoutReference}=bankTerms;
    await runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,
      {...manualTerms,accountLastFour:'1007'},withoutReference));
    expect(await readLedgerDetail(pool,eventId)).toMatchObject({status:'needs_review',
      account:bankTerms.account,bankTransactionId:'retained-reference',amount:{amountMinor:10001}});
  });

  it('rejects bank evidence from another card when the manual movement already identifies its card',async()=>{
    const {eventId}=await createManualPlan();
    await sql.query("UPDATE olbia.ledger_movements SET account_last_four='1007' WHERE id=$1",[eventId]);
    const before=await snapshot();
    await expect(runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,
      {...manualTerms,accountLastFour:'1007'},
      {...bankTerms,account:{...bankTerms.account,lastFour:'1000',accountId:'american_express_mx:1000'}})))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['principal',{principalMinor:10001}],['quota',{cuotaMinor:3334}],['months',{months:4}],
    ['start month',{startMonth:'2026-09'}],['purchase instant',{occurredAt:'2026-10-02T12:00:00.124Z'}],
    ['observed card',{accountLastFour:'1007'}],
  ])('rejects a stale expected %s without changing any native row',async(_label,changed)=>{
    const {eventId}=await createManualPlan();
    const before=await snapshot();
    await expect(runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,{...manualTerms,...changed},bankTerms)))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['non-manual primary',"UPDATE olbia.ledger_observations SET capture_source='email' WHERE movement_id=$1"],
    ['rejected movement',"UPDATE olbia.ledger_movements SET status='rejected' WHERE id=$1"],
    ['deferred movement',"UPDATE olbia.ledger_movements SET status='deferred_msi' WHERE id=$1"],
    ['foreign amount',"UPDATE olbia.ledger_movements SET currency='USD' WHERE id=$1"],
    ['personal zero',"UPDATE olbia.ledger_movements SET personal_amount_minor=0 WHERE id=$1"],
    ['incomplete stub',"UPDATE olbia.installment_plans SET needs_schedule_completion=true WHERE movement_id=$1"],
    ['cancelled plan',"UPDATE olbia.installment_plans SET status='cancelled' WHERE movement_id=$1"],
    ['cancelled installment',"UPDATE olbia.installment_entries SET status='cancelled' WHERE movement_id=$1 AND installment_index=2"],
    ['missing installment',"DELETE FROM olbia.installment_entries WHERE movement_id=$1 AND installment_index=3"],
    ['drifted calendar',"UPDATE olbia.installment_entries SET month='2027-01' WHERE movement_id=$1 AND installment_index=3"],
  ])('rejects an ineligible %s without changing any row',async(_label,statement)=>{
    const {eventId}=await createManualPlan();
    await sql.query(statement,[eventId]);
    const before=await snapshot();
    await expect(runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,manualTerms,bankTerms)))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects both proven and ambiguous prior bank-row relationships',async()=>{
    const {eventId}=await createManualPlan();
    await seedImport();
    const confirmed=markInstallmentSpent(schedule(),1,{amountMinor:3333,occurredOn:'2026-10-02',
      evidenceObservationId:'confirmed-row',confirmedAt:at});
    await runSqlTransaction(pool,client=>replaceInstallmentPlan(client,eventId,confirmed,[
      {installmentIndex:1,kind,contentSha256:hash,rowPosition:0},
    ]));
    const proven=await snapshot();
    await expect(runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,manualTerms,bankTerms)))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    expect(await snapshot()).toEqual(proven);
    await sql.query(`UPDATE olbia.installment_entries SET evidence_origin='ambiguous_bank_row',evidence_import_kind=NULL,
      evidence_content_sha256=NULL,evidence_row_position=NULL WHERE movement_id=$1 AND installment_index=1`,[eventId]);
    await sql.query('INSERT INTO olbia.installment_evidence_candidates VALUES ($1,1,$2,$3,0)',[eventId,kind,hash]);
    const ambiguous=await snapshot();
    await expect(runSqlTransaction(pool,client=>confirmManualPlanBankTerms(client,eventId,manualTerms,bankTerms)))
      .rejects.toBeInstanceOf(LedgerPreconditionError);
    expect(await snapshot()).toEqual(ambiguous);
  });

  it('reserves exactly one mutation and rolls back its current-row update with a later transaction failure',async()=>{
    const {eventId}=await createManualPlan();
    const before=await snapshot();
    await expect(runSqlTransaction(pool,client=>withLedgerMutationBudget(async()=>{
      reserveLedgerMutations(2998);
      await confirmManualPlanBankTerms(client,eventId,manualTerms,bankTerms);
      expect(()=>reserveLedgerMutations(1)).toThrow(LedgerMutationBudgetError);
      throw new Error('Later audit insertion failed');
    }))).rejects.toThrow('Later audit insertion failed');
    expect(await snapshot()).toEqual(before);
  });
});

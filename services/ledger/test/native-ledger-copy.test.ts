import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import { migrateLedger, prepareLedgerCopy, readRetainedLedger, type RetainedLedger } from '../src/dsql/ledger-copy.js';
import { readLedgerMovements,readLedgerDetail } from '../src/dsql/ledger-reads.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS,NATIVE_LEDGER_TABLES,LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import type { SqlClient,TransactionPool } from '../src/dsql/projection.js';

let sql:PGlite,store:OlbiaSqlStore,pool:SqlClient & TransactionPool;
const at='2026-10-02T12:00:00Z',id=randomUUID(),capture=randomUUID(),sha='a'.repeat(64);
const source={bucket:'evidence',key:'original.csv',sha256:sha,contentType:'text/csv'};
const canonical={id,institution:'santander_mx',eventType:'card_purchase',status:'accepted',
  amount:{amountMinor:100,currency:'MXN'},merchantRaw:'Original',occurredAt:at,receivedAt:at,ingestedAt:at,
  source,parserVersion:'original',parseWarnings:[],captureSource:'santander_csv',captureSources:['santander_csv'],
  observationCount:1,primaryObservationId:capture,hasRawEmail:false,tags:['retained']};
const original={id:capture,eventId:id,captureSource:'santander_csv',observedAt:at,reconciliationAt:at,
  institution:'santander_mx',eventType:'card_purchase',amount:{amountMinor:100,currency:'MXN'},merchantRaw:'Original',
  occurredAt:at,source,parserVersion:'original',parseWarnings:[],rowNumber:1,bankTransactionId:'bank-transaction'};
beforeAll(async()=>{
  sql=new PGlite();for(const statement of [...SCHEMA_STATEMENTS,...NATIVE_LEDGER_SCHEMA_STATEMENTS])await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  pool={query:(s,v)=>sql.query<Record<string,unknown>>(s,v),transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};
  store=new OlbiaSqlStore(pool,'metadata');
},30_000);
afterAll(()=>sql.close());
beforeEach(async()=>{
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts','projection_state','movements','movement_observations',
    'movement_revisions','movement_tags','msi_plans','msi_installments','dedupe_claims','bulk_edit_operations',
    'bank_import_candidates','bank_import_rows','bank_imports','command_receipts'].map(t=>`olbia.${t}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version IN (13,14)');
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP)');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  for(const Item of [
    {PK:`EVENT#${id}`,SK:'EVENT',entityType:'observed_purchase',reconciliationAt:at,payload:canonical},
    {PK:`EVENT#${id}`,SK:`OBSERVATION#${at}#${capture}`,entityType:'event_observation',payload:original},
    {PK:'DEDUPE#SANTANDER_CSV#row-token',SK:'CLAIM',entityType:'santander_csv_dedupe',identity:'row-identity',createdAt:at,owner:'owner'},
    {PK:'DEDUPE#AMEX_STATEMENT#missing-token',SK:'CLAIM',entityType:'amex_statement_dedupe',identity:'historical-identity',createdAt:at,eventId:randomUUID()},
    {PK:'DEDUPE#unknown-email',SK:'CLAIM',entityType:'source_dedupe_claim',createdAt:at},
  ])await store.send(new PutCommand({TableName:'metadata',Item}));
  await sql.query(`INSERT INTO olbia.bank_imports
    (kind,content_sha256,owner,status,created_at,evidence_bucket,evidence_key,evidence_content_type)
    VALUES ('santander_csv',$1,'owner','failed',$2,'evidence','original.csv','text/csv')`,[sha,at]);
  await sql.query(`INSERT INTO olbia.bank_import_rows
    (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,row_number,bank_transaction_id)
    VALUES ('santander_csv',$1,0,'row-identity','2026-10-02','Original',100,'new',1,'bank-transaction')`,[sha]);
});
const nativeSnapshot=async()=>Object.fromEntries(await Promise.all(NATIVE_LEDGER_TABLES.map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));

describe('native ledger copy and authority activation',()=>{
  it('copies typed facts and exact CSV relationships atomically while preserving historical claims and frozen recovery',async()=>{
    const retained=await readRetainedLedger(pool),copy=prepareLedgerCopy(retained);
    const missingClaim=retained.claims.map(row=>row.source_item as Record<string,unknown>)
      .find(claim=>claim.identity==='historical-identity')!;
    expect(copy.backfilledCsvClaims).toBe(1);expect(copy.mutationCount).toBe(8);
    const frozen=(await sql.query('SELECT source_item,generation FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows;
    await migrateLedger(pool);
    expect((await sql.query('SELECT movement_id,observation_id FROM olbia.source_claims WHERE capture_source=\'santander_csv\'')).rows)
      .toEqual([{movement_id:id,observation_id:capture}]);
    expect((await sql.query('SELECT outcome,historical_target_id FROM olbia.source_claims WHERE capture_source=\'amex_statement\'')).rows[0])
      .toMatchObject({outcome:'historical_missing',historical_target_id:missingClaim.eventId});
    expect((await sql.query('SELECT outcome FROM olbia.source_claims WHERE capture_source=\'email\'')).rows).toEqual([{outcome:'unresolved_suppression'}]);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows).toHaveLength(1);
    const before=await nativeSnapshot();await migrateLedger(pool);expect(await nativeSnapshot()).toEqual(before);
    expect((await sql.query('SELECT source_item,generation FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows).toEqual(frozen);
    await expect(store.send(new PutCommand({TableName:'metadata',Item:{PK:`EVENT#${id}`,SK:'EVENT',payload:canonical}})))
      .rejects.toMatchObject({name:'MigrationPausedException'});
  });
  it('rolls back real copied rows and the barrier when activation fails, then retries cleanly',async()=>{
    const generation=(await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    let sawCopiedRows=false;
    const interrupted:TransactionPool={transaction:fn=>pool.transaction(client=>fn({query:async(s,v)=>{
      if(s==='INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)'){
        sawCopiedRows=(await client.query('SELECT id FROM olbia.ledger_movements')).rows.length===1 &&
          (await client.query('SELECT token FROM olbia.source_claims')).rows.length===3;
        throw new Error('Interrupted activation');
      }
      return client.query(s,v);
    }}))};
    await expect(migrateLedger(interrupted)).rejects.toThrow('Interrupted activation');expect(sawCopiedRows).toBe(true);
    for(const rows of Object.values(await nativeSnapshot()))expect(rows).toHaveLength(0);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(generation);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows).toHaveLength(0);
    await migrateLedger(pool);expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
  });
  it('fails before copying when original fields, ordered capture assertions or CSV evidence are inconsistent',async()=>{
    const retained=await readRetainedLedger(pool);
    for(const input of [
      {...retained,movements:[{...retained.movements[0],payload:{...canonical,unmappedFinancialField:100}}]},
      {...retained,movements:[{...retained.movements[0],payload:{...canonical,captureSources:['email']}}]},
      {...retained,bankRows:[]},
      {...retained,observations:[...retained.observations,{payload:{...original,id:randomUUID()}}]},
    ])expect(()=>prepareLedgerCopy(input as RetainedLedger)).toThrow('Retained ledger mapping is inconsistent');
    await sql.query('DELETE FROM olbia.schema_migrations WHERE version=13');
    await expect(migrateLedger(pool)).rejects.toThrow('Retained ledger mapping is inconsistent');
    for(const rows of Object.values(await nativeSnapshot()))expect(rows).toHaveLength(0);
  });
  it('rejects an oversized complete copy before issuing native inserts',async()=>{
    const retained=await readRetainedLedger(pool);
    const revisions=Array.from({length:3000},(_,n)=>({payload:{id:`bulk-revision-${n}`,observedPurchaseId:id,
      createdAt:at,changedBy:'owner',changes:{},reason:'Preserved history'}}));
    expect(()=>prepareLedgerCopy({...retained,revisions})).toThrow('Retained ledger mapping is inconsistent');
    for(const rows of Object.values(await nativeSnapshot()))expect(rows).toHaveLength(0);
  });
  it('reads current native financial values and immutable originals without any retained document authority',async()=>{
    await migrateLedger(pool);
    await sql.query('UPDATE olbia.ledger_movements SET amount_minor=200,personal_amount_minor=0 WHERE id=$1',[id]);
    await sql.exec('TRUNCATE olbia.projection_state,olbia.movements,olbia.movement_observations,olbia.movement_revisions');
    const detail=await readLedgerDetail(pool,id);
    expect(detail).toMatchObject({id,amount:{amountMinor:200,currency:'MXN'},personalAmountMinor:0,tags:['retained'],
      source,observationCount:1,captureSources:['santander_csv'],revisions:[],observations:[{
        id:capture,eventId:id,amount:{amountMinor:100,currency:'MXN'},rowNumber:1,bankTransactionId:'bank-transaction',source,
      }]});
    expect(detail).not.toHaveProperty('account');
    expect(await readLedgerMovements(pool,{ids:[]})).toEqual([]);
    expect(await readLedgerDetail(pool,randomUUID())).toBeUndefined();
  });
  it('selects actual installment-month parents and keeps capture append order separate from detail chronology',async()=>{
    await migrateLedger(pool);
    const older=randomUUID();
    await sql.query(`INSERT INTO olbia.ledger_observations
      (id,movement_id,position,capture_source,observed_at,reconciliation_at,institution,event_type,amount_minor,
        currency,merchant_raw,account_present,parser_version,source_metadata)
      VALUES ($1,$2,1,'email',$3,$3,'santander_mx','card_purchase',100,'MXN','Original',false,'email-original','{}')`,
    [older,id,'2026-09-30T12:00:00Z']);
    await sql.query("INSERT INTO olbia.installment_plans VALUES ($1,2,200,100,'manual','active',NULL)",[id]);
    await sql.query(`INSERT INTO olbia.installment_entries
      (movement_id,installment_index,month,amount_minor,status)
      VALUES ($1,1,'2026-11',100,'committed'),($1,2,'2026-12',100,'committed')`,[id]);
    const november=await readLedgerMovements(pool,{months:['2026-11']});
    expect(november).toHaveLength(1);expect(november[0]).toMatchObject({id,hasRawEmail:true,
      captureSources:['santander_csv','email'],observationCount:2,msi:{months:2,principalMinor:200,installments:[
        {index:1,month:'2026-11',amountMinor:100,status:'committed'},
        {index:2,month:'2026-12',amountMinor:100,status:'committed'},
      ]}});
    expect(await readLedgerMovements(pool,{months:['2026-08']})).toEqual([]);
    expect((await readLedgerDetail(pool,id))!.observations).toMatchObject([{id:capture},{id:older}]);
  });
});

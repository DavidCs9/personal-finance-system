import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';

let sql: PGlite;
const at='2026-10-02T12:00:00Z';
type Client={query(statement:string,values?:unknown[]):Promise<unknown>};
const movement=async(client:Client,id:string,primary:string,amount=100)=>client.query(`INSERT INTO olbia.ledger_movements
  (id,primary_observation_id,institution,event_type,status,amount_minor,currency,merchant_raw,received_at,
    ingested_at,reconciliation_at,account_present)
  VALUES ($1,$2,'santander_mx','card_purchase','accepted',$3,'MXN','Original',$4,$4,$4,false)`,[id,primary,amount,at]);
const observation=async(client:Client,id:string,parent:string,position=0)=>client.query(`INSERT INTO olbia.ledger_observations
  (id,movement_id,position,capture_source,observed_at,reconciliation_at,institution,event_type,amount_minor,
    currency,merchant_raw,account_present,parser_version,source_metadata)
  VALUES ($1,$2,$3,'apple_pay_shortcut',$4,$4,'santander_mx','card_purchase',100,'USD','Original',false,'original',
    '{"cardRaw":"Original raw card","requestId":"original-request"}')`,[id,parent,position,at]);
const pair=async(amount=100)=>{
  const id=randomUUID(),capture=randomUUID();
  await sql.transaction(async client=>{await movement(client,id,capture,amount);await observation(client,capture,id);});
  return {id,capture};
};
beforeAll(async()=>{
  sql=new PGlite();for(const statement of [...SCHEMA_STATEMENTS,...NATIVE_LEDGER_SCHEMA_STATEMENTS])await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
},30_000);
afterAll(()=>sql.close());
beforeEach(()=>sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts'].map(t=>`olbia.${t}`).join(',')}`));

describe('native financial ledger schema',()=>{
  it('creates a required primary observation atomically and rolls back an incomplete or cross-movement pair',async()=>{
    const first=await pair();const second=await pair();
    await expect(sql.transaction(client=>movement(client,randomUUID(),randomUUID()))).rejects.toThrow();
    await expect(sql.query('UPDATE olbia.ledger_movements SET primary_observation_id=$2 WHERE id=$1',[first.id,second.capture])).rejects.toThrow();
    await expect(sql.query('DELETE FROM olbia.ledger_observations WHERE id=$1',[first.capture])).rejects.toThrow();
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(2);
    expect((await sql.query('SELECT id FROM olbia.ledger_observations')).rows).toHaveLength(2);
  });
  it('keeps canonical money distinct from original capture money and permits zero Mi parte and zero bank charges',async()=>{
    const {id}=await pair();
    await sql.query('UPDATE olbia.ledger_movements SET personal_amount_minor=0 WHERE id=$1',[id]);
    expect((await sql.query(`SELECT m.amount_minor,m.currency,m.personal_amount_minor,o.amount_minor AS original_amount,
      o.currency AS original_currency,o.account_present FROM olbia.ledger_movements m
      JOIN olbia.ledger_observations o ON o.id=m.primary_observation_id WHERE m.id=$1`,[id])).rows[0])
      .toMatchObject({amount_minor:100,currency:'MXN',personal_amount_minor:0,original_amount:100,original_currency:'USD',account_present:false});
    await expect(pair(0)).resolves.toBeDefined();
    for(const value of [-1,101,Number.MAX_SAFE_INTEGER+1])
      await expect(sql.query('UPDATE olbia.ledger_movements SET personal_amount_minor=$2 WHERE id=$1',[id,value])).rejects.toThrow();
    await expect(sql.query("UPDATE olbia.ledger_movements SET category_id='unknown' WHERE id=$1",[id])).rejects.toThrow();
  });
  it('preserves repeated capture sources with unique positions and ordered warnings/tags',async()=>{
    const {id,capture}=await pair();
    await observation(sql,randomUUID(),id,1);
    await expect(observation(sql,randomUUID(),id,1)).rejects.toThrow();
    await sql.query("INSERT INTO olbia.ledger_movement_warnings VALUES ($1,1,'second'),($1,0,'first')",[id]);
    await sql.query("INSERT INTO olbia.ledger_observation_warnings VALUES ($1,0,'original warning')",[capture]);
    await sql.query("INSERT INTO olbia.ledger_tags VALUES ($1,0,'retained')",[id]);
    await expect(sql.query("INSERT INTO olbia.ledger_tags VALUES ($1,1,'retained')",[id])).rejects.toThrow();
    expect((await sql.query('SELECT capture_source FROM olbia.ledger_observations WHERE movement_id=$1 ORDER BY position',[id])).rows)
      .toEqual([{capture_source:'apple_pay_shortcut'},{capture_source:'apple_pay_shortcut'}]);
    expect((await sql.query('SELECT message FROM olbia.ledger_movement_warnings WHERE movement_id=$1 ORDER BY position',[id])).rows)
      .toEqual([{message:'first'},{message:'second'}]);
  });
  it('links text revision IDs to real operations and preserves frozen category assertions independently of the current catalog',async()=>{
    const {id}=await pair();const op=randomUUID();
    await sql.query(`INSERT INTO olbia.ledger_bulk_operations
      (id,owner,status,created_at,expires_at,selection_assertion,change_assertion)
      VALUES ($1,'owner','pending',$2,9999999999,'{"statuses":["accepted"]}','{"categoryId":"historical-category"}')`,[op,at]);
    await sql.query(`INSERT INTO olbia.ledger_bulk_members
      VALUES ($1,0,$2,'Frozen merchant',$3,'accepted',100,'[]','[]','historical-category','other-historical-category')`,[op,id,at]);
    const revision=`${op}-apply-${id}`;
    await sql.query('INSERT INTO olbia.ledger_revisions VALUES ($1,$2,$3,\'owner\',\'Historical\',$4,\'assistant_chat_category_edit\',\'{}\')',[revision,id,at,op]);
    await expect(sql.query('DELETE FROM olbia.ledger_bulk_operations WHERE id=$1',[op])).rejects.toThrow();
    await expect(sql.query('UPDATE olbia.ledger_revisions SET operation_id=$2 WHERE id=$1',[revision,randomUUID()])).rejects.toThrow();
    await expect(sql.query("UPDATE olbia.ledger_bulk_operations SET status='applied' WHERE id=$1",[op])).rejects.toThrow();
    expect((await sql.query('SELECT id FROM olbia.ledger_revisions')).rows).toEqual([{id:revision}]);
  });
  it('requires claim targets to exist and observations to belong to their claimed movement without discarding unresolved history',async()=>{
    const first=await pair();const second=await pair();
    await sql.query(`INSERT INTO olbia.source_claims
      (capture_source,token,created_at,outcome,movement_id,observation_id)
      VALUES ('santander_csv','row-token',$1,'linked',$2,$3)`,[at,first.id,first.capture]);
    await expect(sql.query("UPDATE olbia.source_claims SET observation_id=$1 WHERE token='row-token'",[second.capture])).rejects.toThrow();
    await sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome,historical_target_id)
      VALUES ('amex_statement','missing-history',$1,'historical_missing',$2)`,[at,randomUUID()]);
    await sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome)
      VALUES ('email','unknown-history',$1,'unresolved_suppression'),('email','intentional-ignore',$1,'suppressed')`,[at]);
    await expect(sql.query("UPDATE olbia.source_claims SET outcome='linked' WHERE token='missing-history'")).rejects.toThrow();
    await expect(sql.query("UPDATE olbia.source_claims SET movement_id=$1 WHERE token='unknown-history'",[first.id])).rejects.toThrow();
    await expect(sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome)
      VALUES ('manual','invalid',$1,'suppressed')`,[at])).rejects.toThrow();
    expect((await sql.query('SELECT token FROM olbia.source_claims')).rows).toHaveLength(4);
  });
  it('requires exact import row coordinates for new evidence and retains explicit historical ambiguity/backfill',async()=>{
    const {id}=await pair();
    const sha='a'.repeat(64);
    await sql.query("INSERT INTO olbia.installment_plans VALUES ($1,3,300,100,'manual','active',NULL)",[id]);
    await sql.query(`INSERT INTO olbia.installment_entries
      (movement_id,installment_index,month,amount_minor,status,confirmed_at,evidence_identity,evidence_origin)
      VALUES ($1,1,'2026-10',100,'spent',$2,'repeated-identity','ambiguous_bank_row'),
        ($1,2,'2026-11',100,'spent',$2,'backfill:original','legacy_backfill')`,[id,at]);
    await expect(sql.query("UPDATE olbia.installment_entries SET evidence_origin='bank_row' WHERE movement_id=$1 AND installment_index=1",[id])).rejects.toThrow();
    await expect(sql.query(`UPDATE olbia.installment_entries SET evidence_origin='bank_row',
      evidence_import_kind='amex_statement',evidence_content_sha256=$2,evidence_row_position=0
      WHERE movement_id=$1 AND installment_index=1`,[id,'a'.repeat(64)])).rejects.toThrow();
    await expect(sql.query('INSERT INTO olbia.installment_evidence_candidates VALUES ($1,1,\'amex_statement\',$2,0)',[id,'a'.repeat(64)])).rejects.toThrow();
    expect((await sql.query('SELECT evidence_origin FROM olbia.installment_entries ORDER BY installment_index')).rows)
      .toEqual([{evidence_origin:'ambiguous_bank_row'},{evidence_origin:'legacy_backfill'}]);
    await sql.query(`INSERT INTO olbia.bank_imports
      (kind,content_sha256,owner,status,created_at,evidence_bucket,evidence_key,evidence_content_type)
      VALUES ('amex_statement',$1,'owner','failed',$2,'evidence','original.pdf','application/pdf')`,[sha,at]);
    await sql.query(`INSERT INTO olbia.bank_import_rows
      (kind,content_sha256,position,identity,occurred_on,merchant_raw,amount_mxn_minor,status,row_kind)
      VALUES ('amex_statement',$1,0,'repeated-identity','2026-10-02','Original',100,'matched','msi'),
        ('amex_statement',$1,1,'new-confirmation','2026-12-02','Original',100,'matched','msi')`,[sha]);
    await sql.query('INSERT INTO olbia.installment_evidence_candidates VALUES ($1,1,\'amex_statement\',$2,0)',[id,sha]);
    await sql.query(`INSERT INTO olbia.installment_entries
      (movement_id,installment_index,month,amount_minor,status,confirmed_at,evidence_identity,evidence_origin,
        evidence_import_kind,evidence_content_sha256,evidence_row_position)
      VALUES ($1,3,'2026-12',100,'spent',$2,'new-confirmation','bank_row','amex_statement',$3,1)`,[id,at,sha]);
    await expect(sql.query("DELETE FROM olbia.bank_import_rows WHERE content_sha256=$1 AND position=1",[sha])).rejects.toThrow();
    await expect(sql.query("DELETE FROM olbia.bank_import_rows WHERE content_sha256=$1 AND position=0",[sha])).rejects.toThrow();
  });
  it('prepares clean relational tables without activating the migration',async()=>{
    const columns=(await sql.query<{column_name:string}>(`SELECT column_name FROM information_schema.columns WHERE
      table_schema='olbia' AND table_name=ANY($1::text[])`,[[...NATIVE_LEDGER_TABLES]])).rows.map(row=>row.column_name);
    for(const forbidden of ['payload','source_pk','source_sk','source_item','row_id','gsi1pk','gsi2pk','gsi3pk'])expect(columns).not.toContain(forbidden);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows).toHaveLength(0);
  });
});

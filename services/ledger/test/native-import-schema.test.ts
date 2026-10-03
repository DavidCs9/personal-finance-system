import { PGlite } from '@electric-sql/pglite';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { SCHEMA_STATEMENTS,migrateBankImports } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient,TransactionPool } from '../src/dsql/projection.js';

let sql:PGlite,pool:TransactionPool,store:OlbiaSqlStore;
const hash='a'.repeat(64),at='2026-10-02T12:00:00.123Z';
const source={bucket:'evidence',key:'original.pdf',sha256:hash,contentType:'application/pdf'};
const row={identity:'same-bank-assertion',occurredOn:'2026-08-01',merchantRaw:'Original',amountMinor:100,status:'matched',
  kind:'msi',msi:true,installmentIndex:1,installmentMonths:3,originalAmountMinor:300,eventId:'historical-selected',
  candidateEventIds:['historical-labeled','historical-unlabeled'],candidates:[{id:'historical-labeled',merchantRaw:'Then',occurredAt:at}]};
const receipt={PK:'USER#owner',SK:`IMPORT#AMEX#${hash}`,entityType:'amex_statement_import',owner:'owner',status:'applied',
  createdAt:at,appliedAt:at,accountLastFour:'1234',product:'Original product',period:{from:'2026-08-01',to:'2026-08-31'},
  source,textractJobId:'original-job',extractionKey:'original.textract.json',textractAnswers:{provider:'original'},
  result:{created:1,linked:0,skipped:0,msiConfirmed:1,createdUnplanned:0},rows:[row]};
beforeAll(async()=>{
  sql=new PGlite();for(const ddl of SCHEMA_STATEMENTS)await sql.query(ddl);
  pool={transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};
  store=new OlbiaSqlStore({...pool,query:(s,v)=>sql.query(s,v)},'metadata');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
},30_000);
afterAll(()=>sql.close());
beforeEach(async()=>{
  await sql.exec('TRUNCATE olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates,olbia.import_records,olbia.projection_state CASCADE');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=13');
  await store.send(new PutCommand({TableName:'metadata',Item:receipt}));
});
describe('native bank import migration',()=>{
  it('copies typed captures, ordered assertions and labeled/unlabeled historical candidates without imposing live movement links',async()=>{
    const frozen=(await sql.query('SELECT * FROM olbia.projection_state')).rows;
    await migrateBankImports(pool);
    expect((await sql.query('SELECT kind,content_sha256,owner,status,evidence_key,result_created,result_msi_confirmed FROM olbia.bank_imports')).rows)
      .toEqual([{kind:'amex_statement',content_sha256:hash,owner:'owner',status:'applied',evidence_key:'original.pdf',result_created:1,result_msi_confirmed:1}]);
    expect((await sql.query('SELECT position,identity,amount_mxn_minor,row_kind,is_credit,selected_movement_id FROM olbia.bank_import_rows')).rows)
      .toEqual([{position:0,identity:row.identity,amount_mxn_minor:100,row_kind:'msi',is_credit:null,selected_movement_id:'historical-selected'}]);
    expect((await sql.query('SELECT position,movement_id,merchant_raw FROM olbia.bank_import_candidates ORDER BY position')).rows)
      .toEqual([{position:0,movement_id:'historical-labeled',merchant_raw:'Then'},{position:1,movement_id:'historical-unlabeled',merchant_raw:null}]);
    expect((await sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual(frozen);
    await expect(store.send(new PutCommand({TableName:'metadata',Item:receipt}))).rejects.toMatchObject({name:'MigrationPausedException'});
    await migrateBankImports(pool);expect((await sql.query('SELECT * FROM olbia.bank_import_rows')).rows).toHaveLength(1);
  });
  it('preserves negative/zero CSV rows, absent statement fields, empty captures and repeated identities across distinct files',async()=>{
    const rows=[0,-100].map((amountMinor,position)=>({identity:`csv-${position}`,occurredOn:'2026-08-01',merchantRaw:'Source',amountMinor,
      status:position?'excluded':'new',rowNumber:position+6,occurrence:1,candidateEventIds:[],candidates:[]}));
    await store.send(new PutCommand({TableName:'metadata',Item:{PK:'USER#owner',SK:`IMPORT#SANTANDER#${hash}`,owner:'owner',
      entityType:'santander_csv_import',importId:hash,status:'previewed',previewedAt:at,accountLastFour:'1234',source:{...source,key:'original.csv',contentType:'text/csv'},rows}}));
    const otherHash='b'.repeat(64);
    await store.send(new PutCommand({TableName:'metadata',Item:{...receipt,SK:`IMPORT#AMEX#${otherHash}`,source:{...source,sha256:otherHash}}}));
    const emptyHash='c'.repeat(64);
    await store.send(new PutCommand({TableName:'metadata',Item:{...receipt,SK:`IMPORT#AMEX#${emptyHash}`,source:{...source,sha256:emptyHash},rows:[]}}));
    await migrateBankImports(pool);
    expect((await sql.query("SELECT position,amount_mxn_minor,row_kind,is_credit,installment_index FROM olbia.bank_import_rows WHERE kind='santander_csv' ORDER BY position")).rows)
      .toEqual([{position:0,amount_mxn_minor:0,row_kind:null,is_credit:null,installment_index:null},{position:1,amount_mxn_minor:-100,row_kind:null,is_credit:null,installment_index:null}]);
    expect((await sql.query('SELECT * FROM olbia.bank_imports')).rows).toHaveLength(4);
    expect((await sql.query('SELECT * FROM olbia.bank_import_rows')).rows).toHaveLength(4);
  });
  it('rolls back every copied relation, marker and barrier on interruption and never overwrites later native state on replay',async()=>{
    const barrier=(await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    await expect(migrateBankImports({transaction:fn=>sql.transaction(async c=>{await fn(c as unknown as SqlClient);throw new Error('Interrupted');})})).rejects.toThrow('bank-import-copy');
    for(const table of ['bank_imports','bank_import_rows','bank_import_candidates'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows).toHaveLength(0);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(barrier);
    await migrateBankImports(pool);
    await sql.query("UPDATE olbia.bank_imports SET product='Native state'");
    await migrateBankImports(pool);expect((await sql.query('SELECT product FROM olbia.bank_imports')).rows).toEqual([{product:'Native state'}]);
  });
  it('retains in-flight and failed captures that have not produced any parsed rows yet',async()=>{
    for(const [status,digit] of [['processing','b'],['failed','c']]){
      const contentHash=digit.repeat(64);
      await store.send(new PutCommand({TableName:'metadata',Item:{PK:'USER#owner',SK:`IMPORT#SANTANDER_STATEMENT#${contentHash}`,
        entityType:'santander_statement_import',owner:'owner',status,createdAt:at,source:{...source,sha256:contentHash},textractJobId:'in-flight-job',
        ...(status==='failed'?{errorMessage:'Original failure'}:{})}}));
    }
    await migrateBankImports(pool);
    expect((await sql.query("SELECT status,account_last_four,period_start FROM olbia.bank_imports WHERE kind='santander_statement' ORDER BY status")).rows)
      .toEqual([{status:'failed',account_last_four:null,period_start:null},{status:'processing',account_last_four:null,period_start:null}]);
    expect((await sql.query('SELECT * FROM olbia.bank_import_rows')).rows).toHaveLength(1);
  });
  it('fails closed for lost fields, malformed arrays, changed classifications, candidate order and source identity',async()=>{
    const variants=[{...receipt,unknown:'do not discard'},{...receipt,rows:null},
      {...receipt,rows:[{...row,msi:false}]},{...receipt,rows:[{...row,amountMinor:'100'}]},
      {...receipt,rows:[{...row,candidates:[{id:'absent',merchantRaw:'Then'}]}]},
      {...receipt,source:{...source,sha256:'b'.repeat(64)}},{...receipt,rows:[{...row,originalAmountMinor:9007199254740992}]}];
    for(const item of variants){
      await sql.query('UPDATE olbia.import_records SET source_item=$1',[JSON.stringify(item)]);
      await expect(migrateBankImports(pool)).rejects.toThrow('bank-import-copy');
      expect((await sql.query('SELECT * FROM olbia.bank_imports')).rows).toHaveLength(0);
      expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows).toHaveLength(0);
    }
  });
  it('enforces per-capture row uniqueness, native parent relations, signed money and complete-copy budget',async()=>{
    await sql.query('UPDATE olbia.import_records SET source_item=$1',[JSON.stringify({...receipt,rows:[row,row]})]);
    await expect(migrateBankImports(pool)).rejects.toThrow('bank-import-copy');
    expect((await sql.query('SELECT * FROM olbia.bank_imports')).rows).toHaveLength(0);
    await sql.query('UPDATE olbia.import_records SET source_item=$1',[JSON.stringify(receipt)]);
    await migrateBankImports(pool);
    await expect(sql.query("DELETE FROM olbia.bank_imports WHERE kind='amex_statement'")).rejects.toThrow();
    await expect(sql.query("UPDATE olbia.bank_import_rows SET amount_mxn_minor=9007199254740992")).rejects.toThrow();
    await expect(sql.query("UPDATE olbia.bank_import_candidates SET row_position=1")).rejects.toThrow();
    await sql.exec('TRUNCATE olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates CASCADE');
    await sql.query('DELETE FROM olbia.schema_migrations WHERE version=13');
    await sql.query('UPDATE olbia.import_records SET source_item=$1',[JSON.stringify({...receipt,rows:Array.from({length:2998},(_,i)=>({...row,identity:String(i)}))})]);
    await expect(migrateBankImports(pool)).rejects.toThrow('bank-import-copy');
    expect((await sql.query('SELECT * FROM olbia.bank_imports')).rows).toHaveLength(0);
  });
});

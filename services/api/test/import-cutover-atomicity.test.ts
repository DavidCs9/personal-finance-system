import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { PutCommand,UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { currentStoreTransaction } from '../../ledger/src/dsql/store.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';

process.env.METADATA_TABLE_NAME='test-metadata';process.env.RAW_EMAIL_BUCKET_NAME='test-evidence';
vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
const {database,tableName}=await import('../src/http/clients.js');
const {applyStatementImport}=await import('../src/imports/statement-shared.js');
const {applySantanderImport}=await import('../src/imports/santander-csv-flow.js');
const {parseSantanderCsv}=await import('../src/imports/santander-csv.js');
let sql: PGlite;
const csv=`No. de Tarjeta: 4262**1234
Producto: UNIQUE REWARDS PLATINUM V
TASA DE INTERÉS ANUALIZADA: 56.46 %
Detalle del 01/ago/2026 al 02/ago/2026,Total de movimientos: 1
FECHA,CONSECUTIVO,CONCEPTO,IMPORTE
01/Ago/2026,2621340486795734,ORIGINAL PURCHASE,$ 1.00`;
beforeAll(async()=>{sql=new PGlite();for(const ddl of SCHEMA_STATEMENTS)await sql.query(ddl);},30_000);
afterAll(()=>sql.close());
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
  await sql.exec('TRUNCATE olbia.projection_state,olbia.movements,olbia.movement_observations,olbia.movement_revisions,olbia.movement_tags,olbia.msi_plans,olbia.msi_installments,olbia.dedupe_claims,olbia.import_records,olbia.command_receipts');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=13');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  vi.spyOn(connection,'createPool').mockReturnValue({query:(s:string,v?:unknown[])=>sql.query(s,v),
    transaction:(fn:(c:SqlClient)=>Promise<unknown>)=>sql.transaction(c=>fn(c as unknown as SqlClient))} as never);
  vi.spyOn(S3Client.prototype,'send').mockResolvedValue({Body:{transformToString:async()=>csv}} as never);
});
describe('whole import apply shares the native cutover transaction',()=>{
  it.each(['amex','santander'] as const)('rolls back actual %s statement rows/claims on blocked completion and retries cleanly',async provider=>{
    const kind=provider==='amex'?'AMEX':'SANTANDER_STATEMENT';
    const importId='a'.repeat(64);
    const row={identity:'original-statement-row',kind:'purchase' as const,merchantRaw:'ORIGINAL PURCHASE',amountMinor:100,
      occurredOn:'2026-08-01',msi:false,credit:false,status:'new' as const,candidateEventIds:[],candidates:[]};
    const item={PK:'USER#owner',SK:`IMPORT#${kind}#${importId}`,entityType:`${provider}_statement_import`,owner:'owner',
      status:'previewed',accountLastFour:'1234',source:{bucket:'test-evidence',key:'original.pdf',sha256:importId},rows:[row]};
    await database.send(new PutCommand({TableName:tableName,Item:item}));
    await assertBlockedCompletionAndRetry(item,()=>applyStatementImport({provider,importId,owner:'owner',decisionBody:undefined,rebuildRows:async()=>[row]}));
  });
  it('rolls back actual CSV rows/claims on blocked completion and retries cleanly',async()=>{
    const importId=createHash('sha256').update(csv,'utf8').digest('hex');
    const document=parseSantanderCsv(csv);
    const item={PK:'USER#owner',SK:`IMPORT#SANTANDER#${importId}`,entityType:'santander_csv_import',owner:'owner',
      status:'previewed',accountLastFour:document.accountLastFour,source:{bucket:'test-evidence',key:'original.csv',sha256:importId},
      rows:document.rows.map(row=>({...row,status:'new',candidateEventIds:[],candidates:[]}))};
    await database.send(new PutCommand({TableName:tableName,Item:item}));
    await assertBlockedCompletionAndRetry(item,()=>applySantanderImport(importId,'owner',undefined));
  });
});

const assertBlockedCompletionAndRetry=async(item:{PK:string;SK:string},apply:()=>Promise<Record<string,unknown>>)=>{
  const baseline=(await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows;
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP)');
  const send=database.send.bind(database);
  let completions=0;
  vi.spyOn(database,'send').mockImplementation((async(command: unknown)=>{
    const input=(command as {input:{Key?:{SK?:string}}}).input;
    if(command instanceof UpdateCommand && input.Key?.SK===item.SK){
      completions++;
      const tx=currentStoreTransaction();expect(tx).toBeDefined();
      // These are real financial writes already performed inside the same transaction.
      for(const table of ['movements','movement_observations','dedupe_claims'])
        expect((await tx!.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(1);
    }
    return send(command as never);
  }) as never);
  await expect(apply()).rejects.toMatchObject({name:'MigrationPausedException'});
  expect(completions).toBe(1);
  for(const table of ['movements','movement_observations','movement_revisions','dedupe_claims','command_receipts'])
    expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
  expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows).toEqual(baseline);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=13');
  expect(await apply()).toMatchObject({summary:{created:1,linked:0,skipped:0}});
  for(const table of ['movements','movement_observations','dedupe_claims'])
    expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(1);
  expect((await sql.query('SELECT status FROM olbia.import_records')).rows).toEqual([{status:'applied'}]);
};

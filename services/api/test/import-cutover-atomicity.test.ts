import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../../ledger/src/dsql/ledger-schema.js';
import * as readers from '../src/events/sql-reads.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { currentSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';

process.env.METADATA_TABLE_NAME='test-metadata';process.env.RAW_EMAIL_BUCKET_NAME='test-evidence';
vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
const {startBankImport,readBankImport}=await import('../src/imports/import-sql.js');
const {applyStatementImport}=await import('../src/imports/statement-shared.js');
const {applySantanderImport}=await import('../src/imports/santander-csv-flow.js');
const {parseSantanderCsv}=await import('../src/imports/santander-csv.js');
let sql: PGlite, interruptCompletion=false, completions=0;
const csv=`No. de Tarjeta: 4262**1234
Producto: UNIQUE REWARDS PLATINUM V
TASA DE INTERÉS ANUALIZADA: 56.46 %
Detalle del 01/ago/2026 al 02/ago/2026,Total de movimientos: 1
FECHA,CONSECUTIVO,CONCEPTO,IMPORTE
01/Ago/2026,2621340486795734,ORIGINAL PURCHASE,$ 1.00`;
beforeAll(async()=>{sql=new PGlite();for(const ddl of [...SCHEMA_STATEMENTS,...NATIVE_LEDGER_SCHEMA_STATEMENTS])await sql.query(ddl);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);},30_000);
afterAll(()=>sql.close());
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts'].map(t=>`olbia.${t}`).join(',')},olbia.projection_state,
    olbia.movements,olbia.movement_observations,olbia.movement_revisions,olbia.movement_tags,olbia.msi_plans,
    olbia.msi_installments,olbia.dedupe_claims,olbia.import_records,olbia.command_receipts,
    olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version IN (13,14)');
  interruptCompletion=false;completions=0;
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  vi.spyOn(readers,'readerPool').mockImplementation(()=>currentSqlClient()??sql);
  vi.spyOn(connection,'createPool').mockReturnValue({query:(s:string,v?:unknown[])=>sql.query(s,v),
    transaction:(fn:(c:SqlClient)=>Promise<unknown>)=>sql.transaction(c=>fn({query:async(s:string,v?:unknown[])=>{
      if(s.startsWith('INSERT INTO olbia.bank_imports') && v?.[3]==='applied'){
        completions++;
        expect(currentSqlClient()).toBeDefined();
        for(const table of ['ledger_movements','ledger_observations','source_claims'])
          expect((await c.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(1);
        if(interruptCompletion){const invalid=[...v];invalid[18]=-1;return c.query(s,invalid);}
      }
      return c.query(s,v);
    }} as SqlClient))} as never);
  vi.spyOn(S3Client.prototype,'send').mockResolvedValue({Body:{transformToString:async()=>csv}} as never);
});
describe('whole import apply shares the native cutover transaction',()=>{
  it.each([
    ['amex','completion'],['santander','completion'],['amex','paused'],['santander','paused'],
  ] as const)('rolls back actual %s statement apply on %s and retries cleanly',async(provider,failure)=>{
    const kind=provider==='amex'?'amex_statement' as const:'santander_statement' as const;
    const importId='a'.repeat(64);
    const row={identity:'original-statement-row',kind:'purchase' as const,merchantRaw:'ORIGINAL PURCHASE',amountMinor:100,
      occurredOn:'2026-08-01',msi:false,credit:false,status:'new' as const,candidateEventIds:[],candidates:[]};
    await startBankImport({kind,importId,owner:'owner',status:'previewed',createdAt:'2026-08-01T12:00:00Z',
      accountLastFour:'1234',product:'Original product',period:{from:'2026-08-01',to:'2026-08-31'},
      source:{bucket:'test-evidence',key:'original.pdf',sha256:importId,contentType:'application/pdf'},rows:[row]});
    await assertNativeCompletionRollbackAndRetry(kind,importId,()=>applyStatementImport({provider,importId,owner:'owner',decisionBody:undefined,prepareRows:async()=>({rebuildRows:async()=>[row]})}),failure);
  });
  it.each(['completion','paused'] as const)('rolls back actual CSV apply on %s and retries cleanly',async failure=>{
    const importId=createHash('sha256').update(csv,'utf8').digest('hex');
    const document=parseSantanderCsv(csv);
    await startBankImport({kind:'santander_csv',importId,owner:'owner',status:'previewed',createdAt:'2026-08-01T12:00:00Z',
      accountLastFour:document.accountLastFour,source:{bucket:'test-evidence',key:'original.csv',sha256:importId,contentType:'text/csv'},
      rows:document.rows.map(row=>({...row,status:'new',candidateEventIds:[],candidates:[]}))});
    await assertNativeCompletionRollbackAndRetry('santander_csv',importId,()=>applySantanderImport(importId,'owner',undefined),failure);
  });
});

const assertNativeCompletionRollbackAndRetry=async(kind:Parameters<typeof readBankImport>[0],importId:string,apply:()=>Promise<Record<string,unknown>>,failure:'completion'|'paused')=>{
  const baseline=(await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows;
  const capture=await readBankImport(kind,importId,'owner',sql);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP)');
  interruptCompletion=failure==='completion';
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  if(failure==='paused')await sql.query("UPDATE olbia.runtime_state SET mode='paused' WHERE id='storage'");
  await expect(apply()).rejects.toMatchObject({name:failure==='completion'?'StorageUnavailableException':'MigrationPausedException'});
  expect(completions).toBe(failure==='completion'?1:0);
  for(const table of ['ledger_movements','ledger_observations','ledger_revisions','source_claims','command_receipts'])
    expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
  expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows).toEqual(baseline);
  expect(await readBankImport(kind,importId,'owner',sql)).toEqual(capture);
  interruptCompletion=false;
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  expect(await apply()).toMatchObject({summary:{created:1,linked:0,skipped:0}});
  for(const table of ['ledger_movements','ledger_observations','source_claims'])
    expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(1);
  const applied=await readBankImport(kind,importId,'owner',sql);
  expect(applied?.status).toBe('applied');expect(applied?.rows).toEqual(capture?.rows);
  const s3Reads=vi.mocked(S3Client.prototype.send).mock.calls.length;
  expect(await apply()).toMatchObject({alreadyApplied:true,summary:{created:1,linked:0,skipped:0}});
  expect(await readBankImport(kind,importId,'owner',sql)).toEqual(applied);
  expect(vi.mocked(S3Client.prototype.send).mock.calls.length).toBe(s3Reads);
  expect(completions).toBe(failure==='completion'?2:1);
  expect((await sql.query('SELECT * FROM olbia.import_records')).rows).toEqual([]);
};

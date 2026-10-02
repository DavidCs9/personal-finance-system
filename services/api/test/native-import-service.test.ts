import { PGlite } from '@electric-sql/pglite';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { currentStoreTransaction,withStoreClient } from '../../ledger/src/dsql/store.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import * as readers from '../src/events/sql-reads.js';
import { readBankImport,startBankImport,saveStatementPreview,failBankImport,completeBankImport,type BankImportRecord } from '../src/imports/import-sql.js';

let sql:PGlite,statements:string[];
const hash='a'.repeat(64),at='2026-10-02T12:00:00.123Z';
const record:BankImportRecord={kind:'santander_csv',importId:hash,owner:'owner',status:'previewed',createdAt:at,previewedAt:at,accountLastFour:'1234',
  source:{bucket:'original-evidence',key:'original.csv',sha256:hash,contentType:'text/csv'},rows:[
    {identity:'first',occurredOn:'2026-08-01',merchantRaw:'Original',amountMinor:0,status:'matched',rowNumber:6,occurrence:1,transactionId:'123',
      candidateEventIds:['historical-labeled','historical-unlabeled'],candidates:[{id:'historical-labeled',merchantRaw:'Historical name',occurredAt:at}]},
    {identity:'credit',occurredOn:'2026-08-02',merchantRaw:'Credit',amountMinor:-100,status:'excluded',rowNumber:7,occurrence:1,candidateEventIds:[],candidates:[]}]};
const processing:BankImportRecord={kind:'amex_statement',importId:hash,owner:'owner',status:'processing',createdAt:at,
  source:{...record.source,key:'original.pdf',contentType:'application/pdf'},textractJobId:'first-job',rows:[]};
const preview={accountLastFour:'1234',product:'Original product',period:{from:'2026-08-01',to:'2026-08-31'},
  extractionKey:'original.textract.json',textractAnswers:{account:'original'},rows:[{identity:'statement',occurredOn:'2026-08-01',merchantRaw:'Original',
    amountMinor:100,status:'new' as const,kind:'purchase' as const,msi:false,credit:false,candidateEventIds:[],candidates:[]}]};
beforeAll(async()=>{sql=new PGlite();for(const ddl of SCHEMA_STATEMENTS)await sql.query(ddl);},30_000);
afterAll(()=>sql.close());
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
  statements=[];await sql.exec('TRUNCATE olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates CASCADE');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  vi.spyOn(connection,'createPool').mockReturnValue({query:(s:string,v?:unknown[])=>{statements.push(s);return sql.query(s,v);},
    transaction:(fn:(c:SqlClient)=>Promise<unknown>)=>sql.transaction(c=>fn({query:(s:string,v?:unknown[])=>{
      statements.push(s);return c.query(s,v);
    }} as SqlClient))} as never);
  vi.spyOn(readers,'readerPool').mockImplementation(()=>currentStoreTransaction()??sql);
});
describe('native import lifecycle and relational evidence',()=>{
  it('preserves signed/zero rows, candidate order and missing labels through an owner-bound consistent SQL read',async()=>{
    expect(await startBankImport(record)).toEqual(record);
    expect(await readBankImport(record.kind,hash,'owner')).toEqual(record);
    expect(await readBankImport(record.kind,hash,'different')).toBeUndefined();
    expect(await readBankImport(record.kind,'missing','owner')).toBeUndefined();
    expect((await sql.query('SELECT * FROM olbia.bank_import_candidates ORDER BY position')).rows).toHaveLength(2);
    expect((await sql.query('SELECT merchant_raw FROM olbia.bank_import_candidates ORDER BY position')).rows)
      .toEqual([{merchant_raw:'Historical name'},{merchant_raw:null}]);
  });
  it('preserves first creation, supports failed retry and ignores stale jobs or late polling after apply',async()=>{
    await startBankImport(processing);
    await failBankImport(processing.kind,hash,'owner','first-job','Original failure');
    expect((await readBankImport(processing.kind,hash,'owner'))?.errorMessage).toBe('Original failure');
    const retry=await startBankImport({...processing,textractJobId:'retry-job',createdAt:'2026-10-02T12:01:00Z'});
    expect(retry.createdAt).toBe(at);expect(retry.status).toBe('processing');
    expect(await saveStatementPreview(processing.kind,hash,'owner','first-job',preview)).toEqual(retry);
    const ready=await saveStatementPreview(processing.kind,hash,'owner','retry-job',preview);
    expect(ready).toMatchObject({...preview,status:'previewed',createdAt:at});
    expect(ready.previewedAt).toBeDefined();
    await completeBankImport(processing.kind,hash,'owner',at,{created:1,linked:0,skipped:0,msiConfirmed:0,createdUnplanned:0});
    const applied=await readBankImport(processing.kind,hash,'owner');
    expect(await failBankImport(processing.kind,hash,'owner','retry-job','Late failure')).toEqual(applied);
    expect(await saveStatementPreview(processing.kind,hash,'owner','retry-job',{...preview,rows:[]})).toEqual(applied);
    expect(await startBankImport({...processing,textractJobId:'late-job'})).toEqual(applied);
    expect(await completeBankImport(processing.kind,hash,'owner','2026-10-02T12:02:00Z',{created:99,linked:99,skipped:99})).toEqual(applied);
  });
  it('keeps one processing job and one applied result under concurrent start/apply, and cannot take over another owner',async()=>{
    const started=await Promise.all([startBankImport(processing),startBankImport({...processing,textractJobId:'second-job'})]);
    expect(started[0]).toEqual(started[1]);expect((await sql.query('SELECT * FROM olbia.bank_imports')).rows).toHaveLength(1);
    await saveStatementPreview(processing.kind,hash,'owner',started[0]!.textractJobId!,preview);
    const applied=await Promise.all([completeBankImport(processing.kind,hash,'owner',at,{created:1,linked:0,skipped:0}),
      completeBankImport(processing.kind,hash,'owner','2026-10-02T12:02:00Z',{created:99,linked:0,skipped:0})]);
    expect(applied[0]).toEqual(applied[1]);expect(applied[0]?.result?.created).toBe(1);
    await expect(startBankImport({...processing,owner:'different'})).rejects.toThrow('La importación cambió');
    expect(await readBankImport(processing.kind,hash,'owner')).toEqual(applied[0]);
  });
  it('rolls back parent and every child on invalid replacement or interruption, preserving the original pending snapshot',async()=>{
    await startBankImport(record);
    await expect(startBankImport({...record,product:'Changed',rows:[...record.rows,{...record.rows[1]!,identity:'unsafe',amountMinor:9007199254740992}]})).rejects.toThrow();
    expect(await readBankImport(record.kind,hash,'owner')).toEqual(record);
    await expect(sql.transaction(c=>withStoreClient(c as unknown as SqlClient,async()=>{
      await startBankImport({...record,rows:[]});
      expect((await readBankImport(record.kind,hash,'owner'))?.rows).toEqual([]);throw new Error('Interrupted');
    }))).rejects.toThrow('Interrupted');
    expect(await readBankImport(record.kind,hash,'owner')).toEqual(record);
    expect((await startBankImport({...record,rows:[]})).rows).toEqual([]);
    expect((await sql.query('SELECT * FROM olbia.bank_import_candidates')).rows).toHaveLength(0);
  });
  it('rejects over-budget or unrepresentable candidate evidence before any parent/child mutation',async()=>{
    const many={...record,rows:Array.from({length:1500},(_,i)=>({...record.rows[0]!,identity:String(i),candidateEventIds:['target'],candidates:[]}))};
    await expect(startBankImport(many)).rejects.toThrow('demasiadas filas');
    expect(statements.filter(s=>/^\s*(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?olbia\.bank_import/.test(s))).toEqual([]);
    await expect(startBankImport({...record,rows:[{...record.rows[0]!,candidates:[{id:'absent',merchantRaw:'Do not discard'}]}]})).rejects.toThrow('La importación cambió');
    for(const table of ['bank_imports','bank_import_rows','bank_import_candidates'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
  });
  it('propagates native SQL failure regardless of obsolete read mode settings',async()=>{
    vi.stubEnv('DSQL_OPERATIONAL_READ_MODE','dynamodb');
    const query=vi.fn(async()=>{throw new Error('Native SQL unavailable');});
    vi.mocked(readers.readerPool).mockReturnValue({query});
    await expect(readBankImport(record.kind,hash,'owner')).rejects.toThrow('Native SQL unavailable');expect(query).toHaveBeenCalledOnce();
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../../ledger/src/dsql/ledger-schema.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { currentStoreTransaction } from '../../ledger/src/dsql/store.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import * as readers from '../src/events/sql-reads.js';
import * as jobs from '../src/imports/textract-document.js';
import * as native from '../src/imports/import-sql.js';
process.env.METADATA_TABLE_NAME='test-metadata';process.env.RAW_EMAIL_BUCKET_NAME='test-evidence';
vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
const amex=await import('../src/imports/amex-statement-flow.js');
const santander=await import('../src/imports/santander-statement-flow.js');
const csvFlow=await import('../src/imports/santander-csv-flow.js');
const shared=await import('../src/imports/statement-shared.js');
const {verifyNativeImports}=await import('../src/imports/read-verification.js');
const providers=[
  {kind:'amex_statement' as const,provider:'amex' as const,preview:amex.previewAmexImport,get:amex.getAmexImport,apply:amex.applyAmexImport,fixture:'amex-gold-live-extraction.json'},
  {kind:'santander_statement' as const,provider:'santander' as const,preview:santander.previewSantanderStatementImport,get:santander.getSantanderStatementImport,apply:santander.applySantanderStatementImport,fixture:'santander-live-extraction.json'},
];
const csv=`No. de Tarjeta: 4262**1234
Producto: UNIQUE REWARDS PLATINUM V
TASA DE INTERÉS ANUALIZADA: 56.46 %
Detalle del 01/ago/2026 al 02/ago/2026,Total de movimientos: 1
FECHA,CONSECUTIVO,CONCEPTO,IMPORTE
01/Ago/2026,2621340486795734,ORIGINAL PURCHASE,$ 1.00`;
const upload={body:Buffer.from('Original PDF').toString('base64'),isBase64Encoded:true,headers:{'content-type':'application/pdf'}};
const id=createHash('sha256').update('Original PDF').digest('hex');
let sql:PGlite,objects:Map<string,Buffer>,jobCounter:number;
beforeAll(async()=>{sql=new PGlite();for(const ddl of [...SCHEMA_STATEMENTS,...NATIVE_LEDGER_SCHEMA_STATEMENTS])await sql.query(ddl);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);},30_000);
afterAll(()=>sql.close());
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
  objects=new Map();jobCounter=0;
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts'].map(t=>`olbia.${t}`).join(',')},olbia.projection_state,
    olbia.movements,olbia.movement_observations,olbia.movement_revisions,olbia.movement_tags,olbia.msi_plans,
    olbia.msi_installments,olbia.dedupe_claims,olbia.import_records,olbia.command_receipts,
    olbia.bank_imports,olbia.bank_import_rows,olbia.bank_import_candidates`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES(13,CURRENT_TIMESTAMP),(14,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');vi.stubEnv('DSQL_OPERATIONAL_READ_MODE','dynamodb');
  vi.spyOn(connection,'createPool').mockReturnValue({query:(s:string,v?:unknown[])=>sql.query(s,v),
    transaction:(fn:(c:SqlClient)=>Promise<unknown>)=>sql.transaction(c=>fn(c as unknown as SqlClient))} as never);
  vi.spyOn(readers,'readerPool').mockImplementation(()=>currentStoreTransaction()??sql);
  vi.spyOn(jobs,'startTextractDocumentAnalysis').mockImplementation(async()=>`job-${++jobCounter}`);
  vi.spyOn(jobs,'getTextractAnalysisJobStatus').mockResolvedValue({status:'SUCCEEDED'});
  vi.spyOn(jobs,'fetchTextractStatementExtraction').mockImplementation(async(_client,jobId,provider)=>{
    const fixture=providers.find(p=>p.provider===provider)!.fixture;
    return {...JSON.parse(readFileSync(new URL(`./fixtures/${fixture}`,import.meta.url),'utf8')),provider,jobId};
  });
  vi.spyOn(S3Client.prototype,'send').mockImplementation((async(command:unknown)=>{
    if(command instanceof PutObjectCommand){
      const key=command.input.Key!;
      if(command.input.IfNoneMatch==='*' && objects.has(key))throw Object.assign(new Error('Retained'),{name:'PreconditionFailed'});
      objects.set(key,Buffer.from(command.input.Body as Uint8Array|string));return {};
    }
    if(command instanceof GetObjectCommand){
      const body=objects.get(command.input.Key!);if(!body)throw new Error('Missing retained evidence');
      return {Body:{transformToString:async()=>body.toString('utf8'),transformToByteArray:async()=>body}};
    }
    throw new Error('Unexpected evidence operation');
  }) as never);
});
describe('native bank import public flows',()=>{
  for(const p of providers){
    it(`${p.provider} uploads, polls, applies and preserves original decisions on repeated upload/apply`,async()=>{
      expect(await p.preview(upload,'owner')).toMatchObject({importId:id,status:'processing'});
      expect(await p.preview(upload,'owner')).toMatchObject({importId:id,status:'processing'});
      expect(jobs.startTextractDocumentAnalysis).toHaveBeenCalledOnce();
      const ready=await p.get(id,'owner');expect(ready).toMatchObject({importId:id,status:'ready'});
      expect((ready.rows as unknown[]).length).toBeGreaterThan(0);
      const capture=await native.readBankImport(p.kind,id,'owner');
      expect(capture?.extractionKey).toContain(createHash('sha256').update('job-1').digest('hex'));
      expect(await p.apply(id,'owner',undefined)).toHaveProperty('summary');
      const applied=await native.readBankImport(p.kind,id,'owner');expect(applied?.status).toBe('applied');
      expect(applied?.rows).toEqual(capture?.rows);
      const writes=vi.mocked(S3Client.prototype.send).mock.calls.filter(([c])=>c instanceof PutObjectCommand).length;
      expect(await p.preview(upload,'owner')).toEqual(ready);
      expect(await p.apply(id,'owner',undefined)).toMatchObject({alreadyApplied:true,summary:applied?.result});
      expect(await native.readBankImport(p.kind,id,'owner')).toEqual(applied);
      expect(vi.mocked(S3Client.prototype.send).mock.calls.filter(([c])=>c instanceof PutObjectCommand)).toHaveLength(writes);
      expect(jobs.startTextractDocumentAnalysis).toHaveBeenCalledOnce();
      expect((await sql.query('SELECT * FROM olbia.import_records')).rows).toEqual([]);
    });
    it(`${p.provider} late failed poll returns the applied preview and cannot rewrite evidence`,async()=>{
      await p.preview(upload,'owner');const ready=await p.get(id,'owner');
      const captured=await native.readBankImport(p.kind,id,'owner');
      // Start this poll from the processing snapshot, then finalize it before its provider response arrives.
      const processing={...captured!,status:'processing' as const,rows:[]};
      vi.spyOn(native,'readBankImport').mockResolvedValueOnce(processing);
      vi.mocked(jobs.getTextractAnalysisJobStatus).mockImplementationOnce(async()=>{
        await native.completeBankImport(p.kind,id,'owner',new Date().toISOString(),{created:0,linked:0,skipped:0});
        return {status:'FAILED',statusMessage:'Late failure'};
      });
      expect(await p.get(id,'owner')).toEqual(ready);
      expect((await native.readBankImport(p.kind,id,'owner'))?.status).toBe('applied');
    });
    it(`${p.provider} retries document failures but keeps transient SQL/evidence failure processing`,async()=>{
      await p.preview(upload,'owner');
      vi.mocked(jobs.fetchTextractStatementExtraction).mockRejectedValueOnce(new jobs.TextractDocumentError('Unreadable original'));
      await expect(p.get(id,'owner')).rejects.toThrow('Unreadable original');
      expect((await native.readBankImport(p.kind,id,'owner'))?.status).toBe('failed');
      const first=(await native.readBankImport(p.kind,id,'owner'))!.createdAt;
      await p.preview(upload,'owner');expect(jobCounter).toBe(2);
      expect((await native.readBankImport(p.kind,id,'owner'))?.createdAt).toBe(first);
      vi.spyOn(native,'saveStatementPreview').mockRejectedValueOnce(new Error('Native SQL unavailable'));
      await expect(p.get(id,'owner')).rejects.toThrow('Native SQL unavailable');
      expect((await native.readBankImport(p.kind,id,'owner'))?.status).toBe('processing');
      expect(await p.get(id,'owner')).toMatchObject({status:'ready'});
      expect(objects.size).toBe(2); // One original PDF and the retry job's immutable extraction.
    });
    it(`${p.provider} expired provider jobs become retryable failed captures while transient errors stay processing`,async()=>{
      await p.preview(upload,'owner');
      vi.mocked(jobs.getTextractAnalysisJobStatus).mockRejectedValueOnce(new Error('Provider unavailable'));
      await expect(p.get(id,'owner')).rejects.toThrow('Provider unavailable');
      expect((await native.readBankImport(p.kind,id,'owner'))?.status).toBe('processing');
      vi.mocked(jobs.getTextractAnalysisJobStatus).mockRejectedValueOnce(new jobs.TextractDocumentError('Vuelve a seleccionar el PDF.'));
      await expect(p.get(id,'owner')).rejects.toThrow('Vuelve a seleccionar el PDF.');
      expect((await native.readBankImport(p.kind,id,'owner'))?.status).toBe('failed');
      await p.preview(upload,'owner');
      expect(jobs.startTextractDocumentAnalysis).toHaveBeenLastCalledWith(expect.anything(),'test-evidence',expect.any(String),p.provider,'job-1');
      expect(await p.get(id,'owner')).toMatchObject({status:'ready'});
    });
    it(`${p.provider} ignores a successful poll for an older job after explicit retry`,async()=>{
      await p.preview(upload,'owner');
      vi.mocked(jobs.fetchTextractStatementExtraction).mockImplementationOnce(async()=>{
        const fixture=JSON.parse(readFileSync(new URL(`./fixtures/${p.fixture}`,import.meta.url),'utf8'));
        await native.failBankImport(p.kind,id,'owner','job-1','Retry required');
        await native.startBankImport({kind:p.kind,importId:id,owner:'owner',status:'processing',createdAt:new Date().toISOString(),
          source:{bucket:'test-evidence',key:`original-${p.provider}.pdf`,sha256:id,contentType:'application/pdf'},textractJobId:'job-2',rows:[]});
        return {...fixture,jobId:'job-1'};
      });
      expect(await p.get(id,'owner')).toMatchObject({status:'processing'});
      expect(await native.readBankImport(p.kind,id,'owner')).toMatchObject({status:'processing',textractJobId:'job-2',rows:[]});
    });
  }
  it('CSV preview and apply preserve original summary/rows on repeated upload without rewriting evidence',async()=>{
    const ready=await csvFlow.previewSantanderImport(csv,'owner');const csvId=String(ready.importId);
    expect(await csvFlow.applySantanderImport(csvId,'owner',undefined)).toMatchObject({summary:{created:1}});
    const applied=await native.readBankImport('santander_csv',csvId,'owner');
    const calls=vi.mocked(S3Client.prototype.send).mock.calls.length;
    expect(await csvFlow.previewSantanderImport(csv,'owner')).toEqual(ready);
    expect(await csvFlow.applySantanderImport(csvId,'owner',undefined)).toMatchObject({alreadyApplied:true,summary:applied?.result});
    expect(vi.mocked(S3Client.prototype.send)).toHaveBeenCalledTimes(calls);
    expect(await native.readBankImport('santander_csv',csvId,'owner')).toEqual(applied);
  });
  it('uses native conditional S3 creation per job, preserves an existing object and propagates other storage errors',async()=>{
    const extraction=await jobs.fetchTextractStatementExtraction({} as never,'job-1','amex');
    const key=await shared.persistTextractExtraction('original.pdf',extraction);
    const original=objects.get(key);
    expect(await shared.persistTextractExtraction('original.pdf',{...extraction,text:'Late differing capture'})).toBe(key);
    expect(objects.get(key)).toEqual(original);
    const second=await shared.persistTextractExtraction('original.pdf',{...extraction,jobId:'job-2'});expect(second).not.toBe(key);
    vi.mocked(S3Client.prototype.send).mockRejectedValueOnce(Object.assign(new Error('Access denied'),{name:'AccessDenied'}));
    await expect(shared.persistTextractExtraction('original.pdf',{...extraction,jobId:'job-3'})).rejects.toThrow('Access denied');
  });
  it('verifies immutable applied history while allowing pending refresh/application and new SQL-only captures',async()=>{
    const preview=await csvFlow.previewSantanderImport(csv,'owner');const csvId=String(preview.importId);
    const pending=(await native.readBankImport('santander_csv',csvId,'owner'))!;
    const {kind,createdAt,importId,...fields}=pending;
    const frozenPending={...fields,PK:'USER#owner',SK:`IMPORT#SANTANDER#${importId}`,importId};
    expect((await verifyNativeImports('owner',[frozenPending],sql)).mismatches).toBe(0);
    await csvFlow.applySantanderImport(csvId,'owner',undefined);
    expect((await verifyNativeImports('owner',[frozenPending],sql)).mismatches).toBe(0);
    const applied=(await native.readBankImport('santander_csv',csvId,'owner'))!;
    const frozenApplied={...frozenPending,status:'applied',appliedAt:applied.appliedAt,result:applied.result};
    const newPreview=await csvFlow.previewSantanderImport(csv.replace('ORIGINAL PURCHASE','NEW CAPTURE'),'owner');
    const gate=await verifyNativeImports('owner',[frozenApplied],sql);
    expect(gate).toMatchObject({authority:'native-sql',imports:2,rows:2,frozenApplied:1,evidenceFiles:2,mismatches:0,validatedConstraints:44});
    expect(newPreview.importId).not.toBe(importId);
    await sql.query("UPDATE olbia.bank_import_rows SET merchant_raw='Changed frozen decision' WHERE kind='santander_csv' AND content_sha256=$1",[csvId]);
    expect((await verifyNativeImports('owner',[frozenApplied],sql)).mismatches).toBeGreaterThan(0);
  });
  it('detects missing applied captures, invalid constraint validation and changed original evidence',async()=>{
    const preview=await csvFlow.previewSantanderImport(csv,'owner');const csvId=String(preview.importId);
    await csvFlow.applySantanderImport(csvId,'owner',undefined);
    const applied=(await native.readBankImport('santander_csv',csvId,'owner'))!;
    const {kind,createdAt,importId,...fields}=applied;
    const frozen={...fields,PK:'USER#owner',SK:`IMPORT#SANTANDER#${importId}`,importId};
    expect((await verifyNativeImports('owner',[frozen],sql)).mismatches).toBe(0);
    objects.set(applied.source.key,Buffer.from('Changed original evidence'));
    expect((await verifyNativeImports('owner',[frozen],sql)).mismatches).toBeGreaterThan(0);
    objects.set(applied.source.key,Buffer.from(csv));
    const client={query:async(s:string,v?:unknown[])=>{const result=await sql.query(s,v);
      return s.includes('pg_constraint')?{rows:result.rows.map(r=>({...r as object,convalidated:false}))}:result as never;
    }};
    expect((await verifyNativeImports('owner',[frozen],client)).mismatches).toBeGreaterThan(0);
    await sql.query('DELETE FROM olbia.bank_import_rows WHERE kind=$1 AND content_sha256=$2',[kind,csvId]);
    await sql.query('DELETE FROM olbia.bank_imports WHERE kind=$1 AND content_sha256=$2',[kind,csvId]);
    expect((await verifyNativeImports('owner',[frozen],sql)).mismatches).toBeGreaterThan(0);
  });

});

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/test/helpers/migration-schema.js';
import * as connection from '../../ledger/src/dsql/connection.js';
import { currentSqlClient,withSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import type { SqlClient } from '../../ledger/src/dsql/projection.js';
import * as readers from '../src/events/sql-reads.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const { ingestNominaXml,getPayslip,listPayslipsForMonth } = await import('../src/imports/cfdi-nomina-flow.js');
const { insertPayslip,payslipExists,readSqlPayslipRecord,MAX_PAYSLIP_LINES } = await import('../src/imports/payroll-sql.js');
const { parseCfdiNominaXml } = await import('../src/imports/cfdi-nomina.js');
const xml = readFileSync(new URL('./fixtures/cfdi-nomina-sample.xml',import.meta.url),'utf8');
const slip = parseCfdiNominaXml(xml);
const evidence = { kind:'cfdi_nomina' as const,bucket:'test-evidence',key:'original.xml',sha256:'a'.repeat(64),contentType:'application/xml' };
let sql: PGlite;
beforeAll(async () => { sql=new PGlite();for(const statement of SCHEMA_STATEMENTS)await sql.query(statement); },30_000);
afterAll(()=>sql.close());
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.payslips,olbia.payslip_lines');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  vi.spyOn(connection,'createPool').mockReturnValue({query:(s:string,v?:unknown[])=>sql.query(s,v),
    transaction:(fn:(c:SqlClient)=>Promise<unknown>)=>sql.transaction(c=>fn(c as unknown as SqlClient))} as never);
  vi.spyOn(readers,'readerPool').mockImplementation(()=>currentSqlClient() ?? sql);
  vi.spyOn(S3Client.prototype,'send').mockResolvedValue({} as never);
});
describe('native immutable payroll service', () => {
  it('imports exact ordered evidence and optional dates, preserving uppercase UUIDs and authenticated access', async () => {
    expect((await ingestNominaXml('owner','original.xml',xml)).status).toBe('created');
    const saved = await getPayslip('owner',slip.month,slip.uuid.toLowerCase());
    expect(saved).toMatchObject({...slip,source:{kind:'cfdi_nomina',contentType:'application/xml'}});
    expect(await getPayslip('different',slip.month,slip.uuid)).toBeUndefined();
    expect(await getPayslip('owner','2026-08',slip.uuid)).toBeUndefined();
    expect(await getPayslip('owner',slip.month,'invalid')).toBeUndefined();
    expect(await listPayslipsForMonth('owner',slip.month)).toEqual([slip]);
    expect((await sql.query('SELECT * FROM olbia.payslip_lines ORDER BY position')).rows).toHaveLength(slip.lines.length);
  });
  it('keeps the first receipt immutable across changed-month/amount/evidence duplicate attempts and concurrent preflight races', async () => {
    expect(await payslipExists(slip.uuid)).toBe(false);expect(await payslipExists(slip.uuid)).toBe(false);
    const results = await Promise.all([insertPayslip('owner',slip,'2026-10-02T12:00:00Z',evidence),
      insertPayslip('owner',slip,'2026-10-02T12:00:01Z',{...evidence,key:'second.xml'})]);
    expect(results.sort()).toEqual(['created','duplicate']);
    const before = await readSqlPayslipRecord('owner',slip.month,slip.uuid);
    expect(await insertPayslip('different',{...slip,month:'2026-08',fechaPago:'2026-08-31',totalMinor:1},'2026-10-02T12:01:00Z',
      {...evidence,key:'changed.xml'})).toBe('duplicate');
    expect(await readSqlPayslipRecord('owner',slip.month,slip.uuid)).toEqual(before);
    expect((await sql.query('SELECT * FROM olbia.payslips')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.payslip_lines')).rows).toHaveLength(slip.lines.length);
  });
  it('rolls back receipt and every line on constraint failure or interruption and allows a complete retry', async () => {
    const bad = {...slip,lines:[...slip.lines,{...slip.lines[0]!,amountMinor:-1}]};
    await expect(insertPayslip('owner',bad,'2026-10-02T12:00:00Z',evidence)).rejects.toThrow();
    for(const table of ['payslips','payslip_lines'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
    await expect(sql.transaction(client=>withSqlClient(client as unknown as SqlClient,async()=>{
      await insertPayslip('owner',slip,'2026-10-02T12:00:00Z',evidence);
      expect(await getPayslip('owner',slip.month,slip.uuid)).toMatchObject(slip);throw new Error('Interrupted');
    }))).rejects.toThrow('Interrupted');
    expect(await payslipExists(slip.uuid)).toBe(false);
    expect(await insertPayslip('owner',slip,'2026-10-02T12:00:00Z',evidence)).toBe('created');
  });
  it('retains a zero-line receipt and absent optional fields without inventing payroll classifications', async () => {
    const {employerName,fechaInicialPago,fechaFinalPago,...required}=slip;
    const empty={...required,lines:[]};
    await insertPayslip('owner',empty,'2026-10-02T12:00:00Z',evidence);
    expect((await readSqlPayslipRecord('owner',slip.month,slip.uuid))?.payslip).toEqual(empty);
    expect(await listPayslipsForMonth('owner',slip.month)).toEqual([empty]);
  });
  it('rejects an oversized receipt before evidence upload or partial storage', async () => {
    const line='<nomina12:OtroPago TipoOtroPago="002" Clave="zero" Concepto="Zero" Importe="0.00" />';
    const large=xml.replace('</nomina12:Nomina>',`${line.repeat(MAX_PAYSLIP_LINES+1)}</nomina12:Nomina>`);
    const result=await ingestNominaXml('owner','oversized.xml',large);
    expect(result).toMatchObject({status:'failed',error:'La nómina tiene demasiadas líneas para guardarse completa.'});
    expect(vi.mocked(S3Client.prototype.send)).not.toHaveBeenCalled();expect(await payslipExists(slip.uuid)).toBe(false);
  });
});

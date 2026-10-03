import { PGlite } from '@electric-sql/pglite';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { SCHEMA_STATEMENTS,migratePayroll } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient,TransactionPool } from '../src/dsql/projection.js';

let sql: PGlite,pool: TransactionPool,store: OlbiaSqlStore;
const uuid = '11111111-1111-1111-1111-111111111111';
const receipt = { PK: 'USER#owner',SK: `PAYROLL#2026-09#${uuid}`,owner: 'owner',month: '2026-09',uuid,
  ingestedAt: '2026-10-02T12:00:00.123Z',source: { kind: 'cfdi_nomina',bucket: 'evidence',key: 'original.xml',sha256: 'a'.repeat(64),contentType: 'application/xml' },
  payload: { uuid,month: '2026-09',fechaPago: '2026-09-30',tipoNomina: 'O',totalMinor: 90,totalPercepcionesMinor: 100,
    totalDeduccionesMinor: 10,totalOtrosPagosMinor: 0,employerName: 'Employer',fechaInicialPago: '2026-09-16',fechaFinalPago: '2026-09-30',
    lines: [{ kind: 'percepcion',tipo: '005',clave: 'repeat',concepto: 'Employer fondo',amountMinor: 100,group: 'fondo',notCashInBank: true },
      { kind: 'deduccion',tipo: '004',clave: 'repeat',concepto: 'Fondo',amountMinor: 10,group: 'fondo' },
      { kind: 'otro_pago',tipo: '002',clave: '',concepto: '',amountMinor: 0,group: 'otro' }] } };
const claim = { PK: `DEDUPE#CFDI_NOMINA#${uuid}`,SK: 'CLAIM',owner: 'owner',uuid,month: '2026-09',entityType: 'cfdi_nomina_dedupe' };
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  pool = { transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) };
  store = new OlbiaSqlStore({ ...pool,query: (s,v) => sql.query(s,v) },'metadata');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
},30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.payslips,olbia.payslip_lines,olbia.payroll,olbia.dedupe_claims,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=12');
  for (const Item of [claim,receipt]) await store.send(new PutCommand({ TableName: 'metadata',Item }));
});
describe('native immutable payroll migration', () => {
  it('copies typed UUID/date/source assertions and every ordered zero/repeated/noncash line without changing evidence', async () => {
    const frozen = (await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk')).rows;
    await migratePayroll(pool);
    expect((await sql.query('SELECT uuid,total_mxn_minor,perceptions_mxn_minor,deductions_mxn_minor,other_payments_mxn_minor,evidence_key FROM olbia.payslips')).rows)
      .toEqual([{uuid:uuid.toLowerCase(),total_mxn_minor:90,perceptions_mxn_minor:100,deductions_mxn_minor:10,other_payments_mxn_minor:0,evidence_key:'original.xml'}]);
    expect((await sql.query('SELECT position,sat_kind,sat_type,code,concept,amount_mxn_minor FROM olbia.payslip_lines ORDER BY position')).rows)
      .toEqual(receipt.payload.lines.map((l,position)=>({position,sat_kind:l.kind,sat_type:l.tipo,code:l.clave,concept:l.concepto,amount_mxn_minor:l.amountMinor})));
    expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk')).rows).toEqual(frozen);
    for (const Item of [claim,receipt]) await expect(store.send(new PutCommand({TableName:'metadata',Item}))).rejects.toMatchObject({name:'MigrationPausedException'});
    await migratePayroll(pool);expect((await sql.query('SELECT * FROM olbia.payslip_lines')).rows).toHaveLength(3);
  });
  it('rolls back receipt/lines/marker/barrier on interruption and preserves later native receipts on replay', async () => {
    const barrier = (await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    await expect(migratePayroll({transaction:fn=>sql.transaction(async client=>{await fn(client as unknown as SqlClient);throw new Error('Interrupted');})})).rejects.toThrow('payroll-copy');
    for (const table of ['payslips','payslip_lines']) expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=12')).rows).toHaveLength(0);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(barrier);
    await migratePayroll(pool);
    await sql.query(`INSERT INTO olbia.payslips SELECT '22222222-2222-2222-2222-222222222222',owner,paid_on,payroll_type,total_mxn_minor,
      perceptions_mxn_minor,deductions_mxn_minor,other_payments_mxn_minor,employer_name,pay_period_start,pay_period_end,ingested_at,
      evidence_bucket,evidence_key,evidence_sha256,evidence_content_type FROM olbia.payslips LIMIT 1`);
    await migratePayroll(pool);expect((await sql.query('SELECT * FROM olbia.payslips')).rows).toHaveLength(2);
  });
  it('fails closed for malformed lists/classifications, orphan claims and unsafe totals before any partial copy', async () => {
    for (const [field,value] of [['lines',null],['lines',[{...receipt.payload.lines[0],group:'otro'}]],['totalMinor','9007199254740992']]) {
      await sql.query('UPDATE olbia.payroll SET payload=$1',[JSON.stringify({...receipt.payload,[field as string]:value})]);
      await expect(migratePayroll(pool)).rejects.toThrow('payroll-copy');
      expect((await sql.query('SELECT * FROM olbia.payslips')).rows).toHaveLength(0);
      expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=12')).rows).toHaveLength(0);
    }
    await sql.query('UPDATE olbia.payroll SET payload=$1',[JSON.stringify(receipt.payload)]);
    await sql.query('DELETE FROM olbia.dedupe_claims');await expect(migratePayroll(pool)).rejects.toThrow('payroll-copy');
  });
  it('enforces receipt/position identity, FK membership, zero-inclusive safe amounts and the atomic row budget', async () => {
    await migratePayroll(pool);
    for (const values of [[uuid,0,'deduccion','004','','',0],[uuid,3,'deduccion','004','','',-1],
      [uuid,3,'deduccion','004','','','9007199254740992'],[uuid,2998,'deduccion','004','','',0],
      ['33333333-3333-3333-3333-333333333333',3,'deduccion','004','','',0]])
      await expect(sql.query('INSERT INTO olbia.payslip_lines VALUES ($1,$2,$3,$4,$5,$6,$7)',values)).rejects.toThrow();
    await sql.query('INSERT INTO olbia.payslip_lines VALUES ($1,3,\'deduccion\',\'004\',\'\',\'\',0)',[uuid]);
    await expect(sql.query('DELETE FROM olbia.payslips WHERE uuid=$1',[uuid])).rejects.toThrow();
  });
  it('preserves a zero-child receipt and fails closed when the complete copy exceeds the native transaction budget', async () => {
    await sql.query('UPDATE olbia.payroll SET payload=$1',[JSON.stringify({...receipt.payload,lines:[]})]);
    await migratePayroll(pool);
    expect((await sql.query('SELECT * FROM olbia.payslips')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.payslip_lines')).rows).toHaveLength(0);
    await sql.exec('TRUNCATE olbia.payslips,olbia.payslip_lines');
    await sql.query('DELETE FROM olbia.schema_migrations WHERE version=12');
    await sql.query('UPDATE olbia.payroll SET payload=$1',[JSON.stringify({...receipt.payload,lines:Array.from({length:3000},()=>receipt.payload.lines[0])})]);
    await expect(migratePayroll(pool)).rejects.toThrow('payroll-copy');
    expect((await sql.query('SELECT * FROM olbia.payslips')).rows).toHaveLength(0);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=12')).rows).toHaveLength(0);
  });
});

import {S3Client} from '@aws-sdk/client-s3';
import {buildMsiSchedule} from '@finance/domain';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {nativeFixture} from './fixtures/native-ledger.js';
import {currentSqlClient} from '../../ledger/src/dsql/sql-runtime.js';
import type {SqlClient,TransactionPool} from '../../ledger/src/dsql/projection.js';
import * as readers from '../src/events/sql-reads.js';
const harness=vi.hoisted(()=>({pool:undefined as unknown as SqlClient&TransactionPool}));
vi.mock('../../ledger/src/dsql/connection.js',()=>({createPool:()=>harness.pool}));
let fixture:Awaited<ReturnType<typeof nativeFixture>>;
let csv:typeof import('../src/imports/santander-csv-flow.js');
let imports:typeof import('../src/imports/import-sql.js');
let shared:typeof import('../src/imports/statement-shared.js');
const document=(month:string,date:string,merchant='AMAZON A MESES',amount='30.00')=>`No. de Tarjeta: 4262**1234
Producto: UNIQUE REWARDS PLATINUM V
TASA DE INTERÉS ANUALIZADA: 56.46 %
Detalle del 01/${month}/2026 al 30/${month}/2026,Total de movimientos: 1
FECHA,CONSECUTIVO,CONCEPTO,IMPORTE
${date}/${month}/2026,2621340486795734,${merchant},$ ${amount}`;
beforeAll(async()=>{
  vi.stubEnv('METADATA_TABLE_NAME','metadata');vi.stubEnv('RAW_EMAIL_BUCKET_NAME','evidence');vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  fixture=await nativeFixture();harness.pool=fixture.pool;
  csv=await import('../src/imports/santander-csv-flow.js');imports=await import('../src/imports/import-sql.js');shared=await import('../src/imports/statement-shared.js');
},30_000);
beforeEach(async()=>{
  await fixture.reset();
  vi.spyOn(readers,'readerPool').mockImplementation(()=>currentSqlClient()??fixture.pool);
  vi.spyOn(S3Client.prototype,'send').mockResolvedValue({} as never);
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await fixture.sql.close();vi.unstubAllEnvs();});

describe('Santander CSV respects the observed bank and card of an MSI plan',()=>{
  it.each([
    {institution:'american_express_mx',lastFour:'1234',currency:'MXN'},
    {institution:'santander_mx',lastFour:'5678',currency:'MXN'},
    {institution:'santander_mx',lastFour:'1234',currency:'USD'},
  ])('does not confirm an equal installment from another source: %o',async input=>{
    await fixture.create({institution:input.institution,account:{institution:input.institution,lastFour:input.lastFour},
      amount:{amountMinor:9000,currency:input.currency},merchantRaw:'AMAZON A MESES',
      msi:buildMsiSchedule({principalMinor:9000,months:3,cuotaMinor:3000,startMonth:'2026-10',origin:'manual'})});
    const preview=await csv.previewSantanderImport(document('oct','04'),'owner');
    expect(preview.rows).toMatchObject([{status:'needs_decision',candidateEventIds:[]}]);
  });

  it.each([{institution:'american_express_mx',status:'accepted'},{institution:'santander_mx',status:'rejected'}] as const)
  ('does not link a regular CSV purchase to an incompatible movement: %o',async input=>{
    await fixture.create({institution:input.institution,status:input.status,account:{institution:input.institution,lastFour:'1234'},
      amount:{amountMinor:10000,currency:'MXN'},merchantRaw:'TIENDA',occurredAt:'2026-10-04T12:00:00Z'});
    expect((await csv.previewSantanderImport(document('oct','04','TIENDA','100.00'),'owner')).rows)
      .toMatchObject([{status:'new',candidateEventIds:[]}]);
  });

  it('confirms later CSV months on the same renamed purchase established by a statement',async()=>{
    const row={identity:'first-quota',kind:'msi' as const,merchantRaw:'AMAZON A MESES',amountMinor:3000,
      occurredOn:'2026-10-04',installmentIndex:1,installmentMonths:3,originalAmountMinor:9000,
      status:'new' as const,candidateEventIds:[],candidates:[]};
    const record={kind:'santander_statement' as const,importId:'a'.repeat(64),owner:'owner',status:'previewed' as const,
      createdAt:'2026-10-04T12:00:00Z',previewedAt:'2026-10-04T12:00:00Z',accountLastFour:'1234',
      product:'Card',period:{from:'2026-10-01',to:'2026-10-31'},source:{bucket:'evidence',key:'original.pdf',sha256:'a'.repeat(64),contentType:'application/pdf'},rows:[row]};
    await imports.startBankImport(record);
    const first=await shared.applyStatementImport({provider:'santander',importId:record.importId,owner:'owner',decisionBody:undefined,
      prepareRows:async()=>({rebuildRows:async()=>[row]})});
    const id=String((first.created as Record<string,unknown>[])[0].id);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET merchant_raw='Mi dron' WHERE id=$1",[id]);
    for(const month of ['nov','dic']){
      const body=document(month,'04').replace('2621340486795734',month==='nov'?'2621340486795735':'2621340486795736');
      const preview=await csv.previewSantanderImport(body,'owner');
      expect(preview.rows).toMatchObject([{status:'matched',candidateEventIds:[id]}]);
      vi.mocked(S3Client.prototype.send).mockResolvedValue({Body:{transformToString:async()=>body}} as never);
      expect(await csv.applySantanderImport(String(preview.importId),'owner',undefined)).toMatchObject({summary:{created:0,msiConfirmed:1}});
    }
    expect((await fixture.sql.query('SELECT movement_id FROM olbia.installment_plans')).rows).toEqual([{movement_id:id}]);
    expect((await fixture.sql.query('SELECT status FROM olbia.installment_entries ORDER BY installment_index')).rows)
      .toEqual([{status:'spent'},{status:'spent'},{status:'spent'}]);
  });
});

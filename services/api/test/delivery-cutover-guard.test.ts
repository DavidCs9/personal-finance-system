import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import type { MonthlyCloseDependencies } from '../src/reports/monthly-close-handler.js';
import type { MonthEndBalanceReminderDependencies } from '../src/reports/month-end-balance-reminder.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';
process.env.MONTHLY_CLOSE_OWNER = 'owner';
process.env.MONTH_END_REMINDER_OWNER = 'owner';
const { runMonthlyClose } = await import('../src/reports/monthly-close-handler.js');
const { runMonthEndBalanceReminder } = await import('../src/reports/month-end-balance-reminder.js');
let sql: PGlite;
const now = new Date('2026-10-03T12:00:00Z');
const prepared = {status:'prepared',email:{subject:'Retained subject',html:'Retained html',text:'Retained text'},facts:{},analysis:{},analysisSource:'fallback',asOfDay:'2026-10-03'};
const flows = [
  {run:(deps:Record<string,unknown>)=>runMonthlyClose(now,deps as unknown as MonthlyCloseDependencies),month:'2026-09'},
  {run:(deps:Record<string,unknown>)=>runMonthEndBalanceReminder(now,deps as unknown as MonthEndBalanceReminderDependencies),month:'2026-10'},
];
const dependencies = (record:unknown=prepared) => ({getRecord:vi.fn(async()=>record),prepare:vi.fn(),markSent:vi.fn(),
  buildFacts:vi.fn(),analyze:vi.fn(),loadOverview:vi.fn(),send:vi.fn(async()=> 'injected-provider-receipt')});
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);},30_000);
afterAll(()=>sql.close());afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');await sql.query('DELETE FROM olbia.schema_migrations WHERE version=17');});

it('preserves prepared reuse and already-sent suppression for both actual orchestration paths before activation',async()=>{
  for(const flow of flows){
    const deps=dependencies();expect(await withStoreClient(sql,()=>flow.run(deps))).toMatchObject({month:flow.month,status:'sent',messageId:'injected-provider-receipt'});
    expect(deps.send).toHaveBeenCalledExactlyOnceWith(prepared.email);expect(deps.prepare).not.toHaveBeenCalled();expect(deps.markSent).toHaveBeenCalledOnce();
    const sent=dependencies({status:'sent'});expect(await withStoreClient(sql,()=>flow.run(sent))).toEqual({month:flow.month,status:'already_sent'});expect(sent.send).not.toHaveBeenCalled();
  }
});

it('blocks both old handler readers and all fact/analysis/delivery IO after native activation',async()=>{
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (17,CURRENT_TIMESTAMP)');
  for(const flow of flows){const deps=dependencies();await expect(withStoreClient(sql,()=>flow.run(deps))).rejects.toMatchObject({name:'MigrationPausedException'});
    for(const dep of Object.values(deps))expect(dep).not.toHaveBeenCalled();}
});

it('rechecks activation immediately before delivery when preparation was already in flight',async()=>{
  for(const flow of flows){
    await sql.query('DELETE FROM olbia.schema_migrations WHERE version=17');const deps=dependencies();deps.getRecord.mockImplementationOnce(async()=>{await sql.query('INSERT INTO olbia.schema_migrations VALUES (17,CURRENT_TIMESTAMP)');return prepared;});
    await expect(withStoreClient(sql,()=>flow.run(deps))).rejects.toMatchObject({name:'MigrationPausedException'});expect(deps.getRecord).toHaveBeenCalledOnce();expect(deps.send).not.toHaveBeenCalled();expect(deps.markSent).not.toHaveBeenCalled();
  }
});

it('sanitizes native guard failures and never falls back to old delivery IO',async()=>{
  const query=vi.fn(async()=>{throw Object.assign(new Error('private provider receipt/content'),{code:'08006'});});
  for(const flow of flows){const deps=dependencies();await expect(withStoreClient({query},()=>flow.run(deps))).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
    for(const dep of Object.values(deps))expect(dep).not.toHaveBeenCalled();}
  expect(query).toHaveBeenCalledTimes(2);
});

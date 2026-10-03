import { PGlite } from '@electric-sql/pglite';
import { WEALTH_ACCOUNTS } from '@finance/domain';
import { SESClient } from '@aws-sdk/client-ses';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { withSqlClient } from '@finance/ledger/sql-runtime';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_DELIVERY_SCHEMA_STATEMENTS } from '../../ledger/src/dsql/delivery-schema.js';
import { verifyNativeMonthlyDeliveries } from '../src/reports/delivery-verification.js';
import { monthlyEmailContentHash } from '@finance/ledger/native-deliveries';
import { getMonthlyEmailDelivery, prepareMonthlyEmailDelivery, markMonthlyEmailAccepted } from '../src/reports/delivery-store.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';
const {runMonthlyClose}=await import('../src/reports/monthly-close-handler.js');
const {runMonthEndBalanceReminder}=await import('../src/reports/month-end-balance-reminder.js');
let sql:PGlite;
const now=new Date('2026-10-03T12:00:00.123Z');
const flows=[{run:()=>runMonthlyClose(now),kind:'monthly_close' as const,month:'2026-09'},
  {run:()=>runMonthEndBalanceReminder(now),kind:'month_end_reminder' as const,month:'2026-10'}];
const legacy=async()=>({records:(await sql.query('SELECT * FROM olbia.delivery_records')).rows,envelopes:(await sql.query('SELECT * FROM olbia.projection_state')).rows});
beforeAll(async()=>{sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,...NATIVE_DELIVERY_SCHEMA_STATEMENTS])await sql.query(s);
  for(const [position,a] of WEALTH_ACCOUNTS.filter(a=>a.sync!=='derived').entries())await sql.query('INSERT INTO olbia.asset_accounts (id,name,institution,role,sync,position) VALUES ($1,$2,$3,$4,$5,$6)',[a.id,a.name,a.institution,a.role,a.sync,position]);
},30_000);
afterAll(()=>sql.close());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
  await sql.exec('TRUNCATE olbia.monthly_email_receipts,olbia.monthly_email_preparations');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  for(const [name,value] of Object.entries({MONTHLY_CLOSE_OWNER:'owner',MONTH_END_REMINDER_OWNER:'owner',
    ALERT_SENDER_EMAIL:'sender@example.test',ALERT_RECIPIENT_EMAIL:'recipient@example.test',WEB_APP_URL:'https://finance.example.test'}))vi.stubEnv(name,value);
  vi.stubEnv('MONTHLY_CLOSE_MODEL_ID','');await sql.query('INSERT INTO olbia.schema_migrations VALUES (17,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
});

it('runs both actual default workers through first native preparation, injected SES acceptance and sent suppression without document writes',async()=>{
  const before=await legacy(),send=vi.spyOn(SESClient.prototype,'send').mockResolvedValue({MessageId:'injected-provider-receipt'} as never);
  for(const flow of flows){
    expect(await withSqlClient(sql,flow.run)).toMatchObject({month:flow.month,status:'sent',messageId:'injected-provider-receipt'});
    const stored=await withSqlClient(sql,()=>getMonthlyEmailDelivery('owner',flow.kind,flow.month));expect(stored).toMatchObject({kind:flow.kind,status:'sent',preparedAt:now.toISOString(),sentAt:now.toISOString(),messageId:'injected-provider-receipt'});
    expect(stored?.contentSha256).toBe(monthlyEmailContentHash(stored!.email));
    const command=send.mock.calls.at(-1)![0] as unknown as {input:Record<string,unknown>};expect(command.input.Message).toEqual({Subject:{Charset:'UTF-8',Data:stored!.email.subject},Body:{Html:{Charset:'UTF-8',Data:stored!.email.html},Text:{Charset:'UTF-8',Data:stored!.email.text}}});
    const count=send.mock.calls.length;expect(await withSqlClient(sql,flow.run)).toEqual({month:flow.month,status:'already_sent'});expect(send).toHaveBeenCalledTimes(count);
  }
  expect(await verifyNativeMonthlyDeliveries('owner',sql)).toMatchObject({activated:true,preparations:2,receipts:2,contentHashes:2,validatedConstraints:13,requiredColumns:12,mismatches:0});
  expect(await legacy()).toEqual(before);
});

it('reuses the exact immutable email on provider failure/retry and never recomputes accepted evidence',async()=>{
  const send=vi.spyOn(SESClient.prototype,'send').mockRejectedValueOnce(Object.assign(new Error('Injected transport failure'),{name:'InjectedProviderError'})).mockResolvedValue({MessageId:'retry-receipt'} as never);
  await expect(withSqlClient(sql,flows[0].run)).rejects.toMatchObject({name:'InjectedProviderError'});
  const prepared=await withSqlClient(sql,()=>getMonthlyEmailDelivery('owner','monthly_close','2026-09'));expect(prepared?.status).toBe('prepared');
  await withSqlClient(sql,flows[0].run);const accepted=await withSqlClient(sql,()=>getMonthlyEmailDelivery('owner','monthly_close','2026-09'));
  expect(accepted).toMatchObject({...prepared,status:'sent',messageId:'retry-receipt'});expect((send.mock.calls[1][0] as unknown as {input:unknown}).input).toEqual((send.mock.calls[0][0] as unknown as {input:unknown}).input);
});

it('preserves the existing external-acceptance ambiguity if receipt storage fails, with no fabricated success record',async()=>{
  const send=vi.spyOn(SESClient.prototype,'send').mockResolvedValue({MessageId:'accepted-with-injected-storage-failure'} as never);
  const client={query:async(s:string,v?:unknown[])=>{if(s.startsWith('INSERT INTO olbia.monthly_email_receipts'))throw Object.assign(new Error('private receipt failure'),{code:'08006'});return sql.query<Record<string,unknown>>(s,v);}};
  await expect(withSqlClient(client,flows[1].run)).rejects.toMatchObject({code:'08006'});
  expect(send).toHaveBeenCalledOnce();expect(await withSqlClient(sql,()=>getMonthlyEmailDelivery('owner','month_end_reminder','2026-10'))).toMatchObject({status:'prepared'});
  expect((await sql.query('SELECT * FROM olbia.monthly_email_receipts')).rows).toEqual([]);
});

it('keeps native conditional preparation/receipt behavior, owner access and full rollback',async()=>{
  const input={kind:'month_end_reminder' as const,owner:'owner',month:'2026-10',asOfDay:'2026-10-03',preparedAt:now.toISOString(),email:{subject:'Exact subject',html:'Exact html',text:'Exact text'}};
  const rollback=new Error('Rollback proof');await expect(sql.transaction(async c=>withSqlClient(c as unknown as {query:typeof sql.query},async()=>{
    await prepareMonthlyEmailDelivery(input);await expect(prepareMonthlyEmailDelivery({...input,email:{...input.email,text:'replacement'}})).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
    expect(await getMonthlyEmailDelivery('other',input.kind,input.month)).toBeUndefined();
    await markMonthlyEmailAccepted({owner:input.owner,kind:input.kind,month:input.month,messageId:'receipt',sentAt:now.toISOString()});throw rollback;
  }))).rejects.toBe(rollback);
  expect((await sql.query('SELECT * FROM olbia.monthly_email_preparations')).rows).toEqual([]);expect((await sql.query('SELECT * FROM olbia.monthly_email_receipts')).rows).toEqual([]);
});

it('sanitizes native read failures and blocks worker delivery without source fallback',async()=>{
  const query=vi.fn(async()=>{throw Object.assign(new Error('private email/receipt'),{code:'08006'});}),send=vi.spyOn(SESClient.prototype,'send').mockResolvedValue({MessageId:'must-not-send'} as never);
  for(const flow of flows)await expect(withSqlClient({query},flow.run)).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
  expect(query).toHaveBeenCalledTimes(2);expect(send).not.toHaveBeenCalled();
  for(const mode of ['paused','dynamodb']) {
    await sql.query("UPDATE olbia.runtime_state SET mode=$1 WHERE id='storage'",[mode]);
    for(const flow of flows)await expect(withSqlClient(sql,flow.run)).rejects.toMatchObject({name:'MigrationPausedException'});
  }
  expect(send).not.toHaveBeenCalled();
  expect((await sql.query('SELECT * FROM olbia.monthly_email_preparations')).rows).toEqual([]);
});

it('independently detects changed email bytes or lost relationships and preserves legitimate unsent preparations',async()=>{
  const input={kind:'month_end_reminder' as const,owner:'owner',month:'2026-10',asOfDay:'2026-10-03',preparedAt:now.toISOString(),email:{subject:'Original subject',html:'Original html',text:'Original text'}};
  await withSqlClient(sql,()=>prepareMonthlyEmailDelivery(input));expect(await verifyNativeMonthlyDeliveries('owner',sql)).toMatchObject({preparations:1,receipts:0,prepared:1,mismatches:0});
  await sql.query("UPDATE olbia.monthly_email_preparations SET email_text='Changed bytes'");expect((await verifyNativeMonthlyDeliveries('owner',sql)).mismatches).toBeGreaterThan(0);
  await sql.query('UPDATE olbia.monthly_email_preparations SET email_text=$1',[input.email.text]);
  const rollback=new Error('Rollback missing FK');await expect(sql.transaction(async c=>{
    await c.query('ALTER TABLE olbia.monthly_email_receipts DROP CONSTRAINT monthly_email_receipt_preparation_fk');
    expect((await verifyNativeMonthlyDeliveries('owner',c as unknown as typeof sql)).mismatches).toBeGreaterThan(0);throw rollback;
  })).rejects.toBe(rollback);expect((await verifyNativeMonthlyDeliveries('owner',sql)).mismatches).toBe(0);
});

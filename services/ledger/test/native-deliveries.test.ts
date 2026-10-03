import { PGlite } from '@electric-sql/pglite';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/store.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';
import { NATIVE_DELIVERY_SCHEMA_STATEMENTS, nativeDeliveryReadGrant, nativeDeliveryWriteGrant } from '../src/dsql/delivery-schema.js';
import { readMonthlyDelivery, monthlyEmailContentHash, insertMonthlyDeliveryPreparation, insertMonthlyDeliveryReceipt, type MonthlyDeliveryPreparation } from '../src/dsql/delivery.js';
import { migrateMonthlyDeliveries, prepareDeliveryCopy } from '../src/dsql/delivery-copy.js';

let sql:PGlite,pool:TransactionPool,store:OlbiaSqlStore;
const at='2026-10-03T12:00:00.123Z',email={subject:'Preserved subject',html:'Exact html',text:'Exact text'};
const common={owner:'owner',month:'2026-09',preparedAt:at,email};
const inputs:MonthlyDeliveryPreparation[]=[{...common,kind:'monthly_close',report:{facts:{month:'2026-09',signedMoney:123},analysis:{headline:'Original analysis'},analysisVersion:'existing-version',analysisSource:'fallback',analysisErrorName:'ExistingProviderError'}},
  {...common,kind:'month_end_reminder',asOfDay:'2026-09-30'}];
const original=(input:MonthlyDeliveryPreparation)=>({PK:'USER#owner',SK:`${input.kind==='monthly_close'?'MONTHLY_CLOSE':'MONTH_END_BALANCE_REMINDER'}#${input.month}`,
  entityType:input.kind==='monthly_close'?'monthly_close_report':'month_end_balance_reminder',owner:input.owner,month:input.month,preparedAt:input.preparedAt,
  email:input.email,contentSha256:monthlyEmailContentHash(input.email),status:'sent',sentAt:at,sesMessageId:'existing-provider-receipt',
  ...(input.kind==='monthly_close'?{facts:input.report.facts,analysis:input.report.analysis,analysisVersion:input.report.analysisVersion,analysisSource:input.report.analysisSource,analysisErrorName:input.report.analysisErrorName}:{asOfDay:input.asOfDay})});
const snapshot=async()=>Object.fromEntries(await Promise.all(['delivery_records','projection_state','monthly_email_preparations','monthly_email_receipts','schema_migrations','application_barrier']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1,2`)).rows])));
beforeAll(async()=>{
  sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,...NATIVE_DELIVERY_SCHEMA_STATEMENTS])await sql.query(s);
  pool={transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),...pool},'metadata');
  for(const role of ['delivery_reader','delivery_writer']){await sql.query(`CREATE ROLE ${role}`);await sql.query(`GRANT USAGE ON SCHEMA olbia TO ${role}`);await sql.query(nativeDeliveryReadGrant(role));}
  await sql.query(nativeDeliveryWriteGrant('delivery_writer'));
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
beforeEach(async()=>{
  await sql.query('RESET ROLE');await sql.exec('TRUNCATE olbia.monthly_email_receipts,olbia.monthly_email_preparations,olbia.delivery_records,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=17');await sql.query('INSERT INTO olbia.schema_migrations VALUES (16,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});
const seed=async()=>{for(const input of inputs)await store.send(new PutCommand({TableName:'metadata',Item:original(input)}));};

it('copies both exact immutable email/evidence variants and receipts, retains recovery, and resumes without restoring changed current state',async()=>{
  await seed();const retained=(await sql.query('SELECT * FROM olbia.delivery_records ORDER BY 1,2')).rows;
  await migrateMonthlyDeliveries(pool);
  for(const input of inputs)expect(await readMonthlyDelivery(sql,'owner',input.kind,input.month)).toEqual({...input,contentSha256:monthlyEmailContentHash(email),status:'sent',sentAt:at,messageId:'existing-provider-receipt'});
  expect(await readMonthlyDelivery(sql,'other','monthly_close','2026-09')).toBeUndefined();
  await insertMonthlyDeliveryPreparation(sql,{...inputs[0],month:'2026-10'});await migrateMonthlyDeliveries(pool);
  expect(await readMonthlyDelivery(sql,'owner','monthly_close','2026-10')).toMatchObject({status:'prepared'});
  expect((await sql.query('SELECT * FROM olbia.delivery_records ORDER BY 1,2')).rows).toEqual(retained);
  await expect(store.send(new PutCommand({TableName:'metadata',Item:original(inputs[0])}))).rejects.toMatchObject({name:'MigrationPausedException'});
});

it('atomically prepares once, derives sent state from one owned receipt, and cannot replace original contents',async()=>{
  for(const input of inputs){
    await insertMonthlyDeliveryPreparation(sql,input);expect(await readMonthlyDelivery(sql,input.owner,input.kind,input.month)).toMatchObject({status:'prepared'});
    await expect(insertMonthlyDeliveryPreparation(sql,{...input,email:{...email,text:'replacement'}})).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
    await expect(insertMonthlyDeliveryReceipt(sql,{owner:'other',kind:input.kind,month:input.month,messageId:'foreign',sentAt:at})).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
    await expect(insertMonthlyDeliveryReceipt(sql,{owner:input.owner,kind:input.kind,month:input.month,messageId:'early',sentAt:'2026-10-03T12:00:00Z'})).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
    await insertMonthlyDeliveryReceipt(sql,{owner:input.owner,kind:input.kind,month:input.month,messageId:'accepted',sentAt:at});
    await expect(insertMonthlyDeliveryReceipt(sql,{owner:input.owner,kind:input.kind,month:input.month,messageId:'replacement',sentAt:at})).rejects.toMatchObject({name:'ConditionalCheckFailedException'});
    expect(await readMonthlyDelivery(sql,input.owner,input.kind,input.month)).toMatchObject({email,status:'sent',messageId:'accepted'});
  }
});

it('enforces actual append-only roles, parent ownership and kind-specific database constraints',async()=>{
  await sql.query('SET ROLE delivery_writer');await insertMonthlyDeliveryPreparation(sql,inputs[0]);
  for(const table of ['monthly_email_preparations','monthly_email_receipts']){
    await expect(sql.query(`DELETE FROM olbia.${table}`)).rejects.toMatchObject({code:'42501'});
    await expect(sql.query(`UPDATE olbia.${table} SET month=month`)).rejects.toMatchObject({code:'42501'});
  }
  await insertMonthlyDeliveryReceipt(sql,{owner:'owner',kind:'monthly_close',month:'2026-09',messageId:'receipt',sentAt:at});
  await sql.query('SET ROLE delivery_reader');expect(await readMonthlyDelivery(sql,'owner','monthly_close','2026-09')).toMatchObject({status:'sent'});
  await expect(insertMonthlyDeliveryPreparation(sql,inputs[1])).rejects.toMatchObject({code:'42501'});
  await sql.query('RESET ROLE');
  await expect(sql.query("INSERT INTO olbia.monthly_email_receipts VALUES ('monthly_close','2026-11',$1,'orphan')",[at])).rejects.toMatchObject({code:'23503'});
  await expect(sql.query("UPDATE olbia.monthly_email_preparations SET delivery_kind='unsupported'")).rejects.toMatchObject({code:'23514'});
  await expect(sql.query("UPDATE olbia.monthly_email_preparations SET report_facts=NULL")).rejects.toMatchObject({code:'23514'});
  await expect(sql.query("UPDATE olbia.monthly_email_preparations SET month='2026-13'")).rejects.toMatchObject({code:'23514'});
});

it('rejects unknown/corrupt/source projection mappings, partial state and invalid native preparations before activation',async()=>{
  await seed();const row=(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.delivery_records')).rows[0],source=row.source_item as Record<string,unknown>;
  for(const corrupted of [{...row,content_sha256:'0'.repeat(64)},{...row,source_item:{...source,extra:'unrepresentable'}},{...row,source_item:{...source,contentSha256:'0'.repeat(64)}},
    {...row,source_item:{...source,status:'prepared'}},{...row,source_item:{...source,email:{...email,extra:'unrepresentable'}}}])expect(()=>prepareDeliveryCopy([corrupted])).toThrow();
  await insertMonthlyDeliveryPreparation(sql,inputs[0]);const before=await snapshot();await expect(migrateMonthlyDeliveries(pool)).rejects.toThrow('inconsistent');expect(await snapshot()).toEqual(before);
  await expect(insertMonthlyDeliveryPreparation(sql,{...inputs[1],asOfDay:'2026-09-31'} as MonthlyDeliveryPreparation)).rejects.toThrow('Invalid');
});

it('rolls back copied preparations, receipts, marker and barrier when interrupted, then cleanly retries',async()=>{
  await seed();const before=await snapshot();const failing:TransactionPool={transaction:fn=>sql.transaction(c=>fn({query:async(s,v)=>{
    const result=await c.query<Record<string,unknown>>(s,v);if(s.includes('INSERT INTO olbia.monthly_email_receipts'))throw new Error('Interrupted copy');return result;
  }}))};
  await expect(migrateMonthlyDeliveries(failing)).rejects.toThrow('Interrupted copy');expect(await snapshot()).toEqual(before);
  await migrateMonthlyDeliveries(pool);expect((await sql.query('SELECT * FROM olbia.monthly_email_receipts')).rows).toHaveLength(2);
});

it('activates empty registries and preserves a prepared unsent record without manufacturing a receipt',async()=>{
  await migrateMonthlyDeliveries(pool);expect((await sql.query('SELECT * FROM olbia.monthly_email_receipts')).rows).toEqual([]);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=17');
  const {sentAt,sesMessageId,...prepared}=original(inputs[0]);await store.send(new PutCommand({TableName:'metadata',Item:{...prepared,status:'prepared'}}));
  await migrateMonthlyDeliveries(pool);expect(await readMonthlyDelivery(sql,'owner','monthly_close','2026-09')).toMatchObject({status:'prepared',email});
  expect((await sql.query('SELECT * FROM olbia.monthly_email_receipts')).rows).toEqual([]);
});

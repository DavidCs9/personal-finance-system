import { PGlite } from '@electric-sql/pglite';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import { saveObservedEvent, type CaptureSource, type SaveObservedEventInput } from './fixtures/legacy-observed-events.js';
import type { SqlClient } from '../src/dsql/projection.js';
import type { SourceItem } from '../src/dsql/model.js';

let sql: PGlite, store: OlbiaSqlStore;
const at='2026-10-02T12:00:00Z';
const movement: SourceItem={PK:'EVENT#movement',SK:'EVENT',entityType:'observed_purchase',payload:{id:'movement',
  institution:'santander_mx',eventType:'card_purchase',status:'accepted',amount:{amountMinor:100,currency:'MXN'},
  merchantRaw:'Original',receivedAt:at,occurredAt:at,tags:['retained'],msi:{months:1,principalMinor:100,cuotaMinor:100,
    status:'active',origin:'manual',installments:[{index:1,month:'2026-10',amountMinor:100,status:'committed'}]}}};
const observation: SourceItem={PK:movement.PK,SK:`OBSERVATION#${at}#observation`,entityType:'event_observation',
  payload:{id:'observation',eventId:'movement',captureSource:'email',observedAt:at,reconciliationAt:at,
    amount:{amountMinor:100,currency:'MXN'},merchantRaw:'Original'}};
const revision: SourceItem={PK:movement.PK,SK:`REVISION#${at}#bulk-apply-movement`,entityType:'event_revision',
  payload:{id:'bulk-apply-movement',observedPurchaseId:'movement',createdAt:at,changedBy:'owner',reason:'Historical',
    changes:{tags:{previous:[],next:['retained']}}}};
const claims: SourceItem[]=['email-fingerprint','apple_pay_shortcut:request','MANUAL#fingerprint','SANTANDER_CSV#row',
  'AMEX_STATEMENT#row','SANTANDER_STATEMENT#row'].map(key=>({PK:`DEDUPE#${key}`,SK:'CLAIM',
    entityType:'source_dedupe_claim',eventId:'movement',observationId:'observation',createdAt:at}));
const ignored: SourceItem={PK:'DEDUPE#ignored-email',SK:'CLAIM',entityType:'source_dedupe_claim',createdAt:at};
const missingTarget: SourceItem={...claims[4],PK:'DEDUPE#AMEX_STATEMENT#missing-target',eventId:'missing-movement'};
const operation: SourceItem={PK:'BULK_EDIT#owner',SK:'OP#preview',entityType:'bulk_edit_operation',
  payload:{operationId:'preview',owner:'owner',status:'pending',createdAt:at,events:[]}};
const records=[movement,observation,revision,...claims,ignored,missingTarget,operation];
const key=(item: SourceItem)=>({TableName:'metadata',Key:{PK:item.PK,SK:item.SK}});
const put=(Item: SourceItem)=>new PutCommand({TableName:'metadata',Item});
const mark=()=>sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
const tables=['projection_state','movements','movement_observations','movement_revisions','movement_tags',
  'msi_plans','msi_installments','dedupe_claims','bulk_edit_operations','exception_claims','command_receipts'];
const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,
  (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2,3`)).rows])));
const unrelated: SourceItem={PK:'EXCEPTION_DEDUPE#other',SK:'CLAIM',entityType:'ingestion_exception_claim',createdAt:at};
beforeAll(async()=>{
  sql=new PGlite();for(const statement of SCHEMA_STATEMENTS)await sql.query(statement);
  store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},'metadata');
},30_000);
afterAll(()=>sql.close());
beforeEach(async()=>{
  await sql.exec(`TRUNCATE ${tables.map(table=>`olbia.${table}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=14');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

describe('complete core ledger cutover prerequisite',()=>{
  it('allows normal event/history/claim mutations before the marker',async()=>{
    for(const item of records){
      await store.send(put(item));
      await store.send(new UpdateCommand({...key(item),UpdateExpression:'SET #extra=:value',
        ExpressionAttributeNames:{'#extra':'extra'},ExpressionAttributeValues:{':value':'before-copy'}}));
      expect((await store.send(new GetCommand(key(item)))).Item).toEqual({...item,extra:'before-copy'});
      await store.send(new DeleteCommand(key(item)));
      expect((await store.send(new GetCommand(key(item)))).Item).toBeUndefined();
    }
    for(const table of ['movements','movement_tags','msi_plans','msi_installments'])
      expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
  });
  it('freezes every ledger mutation including ignored/dangling claims and preserves exact reads',async()=>{
    for(const item of records)await store.send(put(item));
    const before=await snapshot();await mark();
    for(const item of records){
      for(const command of [put(item),new DeleteCommand(key(item)),new UpdateCommand({...key(item),
        UpdateExpression:'SET #extra=:value',ExpressionAttributeNames:{'#extra':'extra'},ExpressionAttributeValues:{':value':'late'}})])
        await expect(store.send(command)).rejects.toMatchObject({name:'MigrationPausedException'});
      expect((await store.send(new GetCommand(key(item)))).Item).toEqual(item);
    }
    expect(await snapshot()).toEqual(before);
    await store.send(put(unrelated));
    expect((await store.send(new GetCommand(key(unrelated)))).Item).toEqual(unrelated);
  });
  it('rolls back earlier unrelated writes, projections and receipts in mixed and sequential transactions',async()=>{
    for(const item of records)await store.send(put(item));
    const before=await snapshot();await mark();
    const generation=(await sql.query('SELECT generation FROM olbia.application_barrier')).rows;
    for(const item of [movement,observation,revision,ignored,operation]){
      await expect(store.send(new TransactWriteCommand({ClientRequestToken:'late-ledger',TransactItems:[
        {Put:{TableName:'metadata',Item:unrelated}}, {Delete:{...key(item)}}
      ]}))).rejects.toMatchObject({name:'MigrationPausedException'});
      await expect(store.transaction(async()=>{
        await store.send(new TransactWriteCommand({ClientRequestToken:'earlier-operation',TransactItems:[
          {Put:{TableName:'metadata',Item:unrelated}}]}));
        await store.send(new DeleteCommand(key(item)));
      })).rejects.toMatchObject({name:'MigrationPausedException'});
    }
    expect(await snapshot()).toEqual(before);
    expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual(generation);
  });
  it('restores every family and marker absence when a shared cutover aborts',async()=>{
    for(const item of records)await store.send(put(item));
    const before=await snapshot();
    await expect(store.transaction(async client=>{
      for(const item of records)await store.send(new DeleteCommand(key(item)));
      await client.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
      throw new Error('Interrupted cutover');
    })).rejects.toThrow('Interrupted cutover');
    expect(await snapshot()).toEqual(before);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows).toHaveLength(0);
    await store.send(put(operation));
  });
  it.each(['email','apple_pay_shortcut','manual','santander_csv','amex_statement','santander_statement'] as const)(
    'blocks an actual new %s observation/claim after cutover without partial rows',async source=>{
      const input=observedInput(source);await mark();const before=await snapshot();
      await expect(saveObservedEvent(input)).rejects.toMatchObject({name:'MigrationPausedException'});
      expect(await snapshot()).toEqual(before);
    });
  it('blocks cross-source reconciliation, same-source retry claims and legacy claim recovery without changing history',async()=>{
    await saveObservedEvent(observedInput('email'));
    await store.send(put({...ignored,PK:'DEDUPE#legacy-claim'}));
    await mark();const before=await snapshot();
    for(const input of [observedInput('apple_pay_shortcut'),{...observedInput('email'),dedupeKey:'email-retry'},
      {...observedInput('email'),dedupeKey:'legacy-claim'}])
      await expect(saveObservedEvent(input)).rejects.toMatchObject({name:'MigrationPausedException'});
    expect(await snapshot()).toEqual(before);
    expect(await saveObservedEvent(observedInput('email'))).toMatchObject({duplicate:true,created:false});
    expect(await snapshot()).toEqual(before);
  });
});

const observedInput=(captureSource: CaptureSource): SaveObservedEventInput=>({
  database:{send:command=>store.send(command)} as SaveObservedEventInput['database'],tableName:'metadata',
  captureSource,dedupeKey:`new-${captureSource}`,reconciliationAt:at,
  event:{id:`new-${captureSource}`,institution:'santander_mx',eventType:'card_purchase',status:'accepted',
    amount:{amountMinor:100,currency:'MXN'},merchantRaw:'Original',receivedAt:at,ingestedAt:at,occurredAt:at,
    source:{kind:captureSource},parserVersion:'original-parser',parseWarnings:[]},
});

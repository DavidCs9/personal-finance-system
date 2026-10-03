import { PGlite } from '@electric-sql/pglite';
import { GetCommand,PutCommand,UpdateCommand,DeleteCommand,TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite,store: OlbiaSqlStore;
const imports = [
  ['AMEX','amex_statement_import'],['SANTANDER_STATEMENT','santander_statement_import'],['SANTANDER','santander_csv_import'],
].map(([kind,entityType]) => ({PK:'USER#owner',SK:`IMPORT#${kind}#${'a'.repeat(64)}`,entityType,owner:'owner',status:'previewed',
  source:{bucket:'evidence',key:'original',sha256:'a'.repeat(64)},rows:[{identity:'retained-row',amountMinor:0}]}));
const input = (item: {PK:string;SK:string}) => ({TableName:'metadata',Key:{PK:item.PK,SK:item.SK}});
const put = (Item: Record<string,unknown>) => new PutCommand({TableName:'metadata',Item});
const claim = {PK:'DEDUPE#ordinary-source',SK:'CLAIM',entityType:'source_dedupe_claim'};
const movement = {PK:'EVENT#movement',SK:'EVENT',entityType:'observed_purchase',payload:{id:'movement',institution:'santander_mx',
  eventType:'card_purchase',status:'accepted',amount:{amountMinor:100,currency:'MXN'},merchantRaw:'Original',
  receivedAt:'2026-10-02T12:00:00Z',occurredAt:'2026-10-02T12:00:00Z'}};
const mark = () => sql.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP)');
beforeAll(async () => {
  sql=new PGlite();for(const statement of SCHEMA_STATEMENTS)await sql.query(statement);
  store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},'metadata');
},30_000);
afterAll(()=>sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.projection_state,olbia.import_records,olbia.movements,olbia.movement_tags,olbia.msi_plans,olbia.msi_installments,olbia.dedupe_claims,olbia.command_receipts');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=13');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});
describe('native import cutover prerequisite',() => {
  it('allows every provider lifecycle before the copy marker',async () => {
    for(const item of imports){
      await store.send(put(item));
      await store.send(new UpdateCommand({...input(item),UpdateExpression:'SET #status=:status',
        ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':status':'applied'}}));
      expect((await store.send(new GetCommand(input(item)))).Item).toEqual({...item,status:'applied'});
      await store.send(new DeleteCommand(input(item)));
      expect((await store.send(new GetCommand(input(item)))).Item).toBeUndefined();
    }
  });
  it('blocks late Put/Update/Delete for all providers while retaining exact evidence reads',async () => {
    for(const item of imports)await store.send(put(item));
    const before=(await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_sk')).rows;
    await mark();
    for(const item of imports){
      for(const command of [put(item),new DeleteCommand(input(item)),new UpdateCommand({...input(item),
        UpdateExpression:'SET #status=:status',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':status':'applied'}})])
        await expect(store.send(command)).rejects.toMatchObject({name:'MigrationPausedException'});
      expect((await store.send(new GetCommand(input(item)))).Item).toEqual(item);
    }
    expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_sk')).rows).toEqual(before);
    await store.send(put(claim));await store.send(put(movement));
    expect((await store.send(new GetCommand(input(movement)))).Item).toEqual(movement);
  });
  it('rolls back sequential financial writes and command receipts when final completion is blocked',async () => {
    for(const item of imports)await store.send(put(item));
    await mark();
    for(const item of imports)await expect(store.transaction(async () => {
      await store.send(new TransactWriteCommand({ClientRequestToken:'import-row',TransactItems:[claim,movement].map(Item=>({Put:{TableName:'metadata',Item}}))}));
      await store.send(new UpdateCommand({...input(item),UpdateExpression:'SET #status=:status',
        ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':status':'applied'}}));
    })).rejects.toMatchObject({name:'MigrationPausedException'});
    for(const table of ['movements','dedupe_claims','command_receipts'])expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
    for(const item of imports)expect((await store.send(new GetCommand(input(item)))).Item).toEqual(item);
  });
  it('restores the marker, financial writes and import evidence when cutover aborts',async () => {
    for(const item of imports)await store.send(put(item));
    await expect(store.transaction(async client=>{
      for(const item of imports)await store.send(new DeleteCommand(input(item)));
      await client.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP)');throw new Error('Interrupted');
    })).rejects.toThrow('Interrupted');
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows).toHaveLength(0);
    for(const item of imports)expect((await store.send(new GetCommand(input(item)))).Item).toEqual(item);
    await store.send(put(claim));
  });
});

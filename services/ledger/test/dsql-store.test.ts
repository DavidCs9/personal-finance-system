import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand, BatchGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import { withSqlClient } from '../src/dsql/sql-runtime.js';
import { conditionMatches, updateItem } from '../src/dsql/expressions.js';
import { verifyKey } from '../src/dsql/verification.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';
import type { SourceItem } from '../src/dsql/model.js';
let sql:PGlite, pool:SqlClient & TransactionPool, store:OlbiaSqlStore;
const TableName='metadata';
const record=(id:string):SourceItem=>({PK:`USER#owner`,SK:`CARD#${id}`,entityType:'card',id,owner:'owner',name:'Card',cutOffDay:10,paymentDueDay:20,payload:{id,name:'Card',cutOffDay:10,paymentDueDay:20},GSI1PK:'CARDS',GSI1SK:id});
beforeAll(async()=>{sql=new PGlite();for(const ddl of SCHEMA_STATEMENTS) await sql.query(ddl);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  pool={query:async(s,v)=>sql.query(s,v),transaction:callback=>sql.transaction(client=>callback(client as unknown as SqlClient))};
  store=new OlbiaSqlStore(pool,TableName);
},30000);
afterAll(async()=>sql.close());
describe('Olbia SQL write authority',()=>{
  it('atomically updates envelopes and derived rows, removes stale optional fields, tombstones and recreates',async()=>{
    let item:SourceItem={...record('write'),unknown:{retained:true}};
    await store.send(new PutCommand({TableName,Item:item}));
    await store.send(new UpdateCommand({TableName,Key:item,UpdateExpression:'SET payload.#name = :name REMOVE unknown',ExpressionAttributeNames:{'#name':'name'},ExpressionAttributeValues:{':name':'Changed'},ReturnValues:'ALL_NEW'}));
    item={...record('write'),payload:{...(record('write').payload as object),name:'Changed'}};
    expect((await store.send(new GetCommand({TableName,Key:item}))).Item).toEqual(item);
    expect(await verifyKey(pool,async()=>item,item)).toBe('equal');
    await store.send(new DeleteCommand({TableName,Key:item}));
    expect((await store.send(new GetCommand({TableName,Key:item}))).Item).toBeUndefined();
    expect(await verifyKey(pool,async()=>undefined,item)).toBe('equal');
    await store.send(new PutCommand({TableName,Item:item}));
    expect(await verifyKey(pool,async()=>item,item)).toBe('equal');
  });
  it('cancels the whole transaction on a failed claim and preserves native token idempotence',async()=>{
    const a=record('claim-a'),b=record('claim-b');await store.send(new PutCommand({TableName,Item:a}));
    await expect(store.send(new TransactWriteCommand({TransactItems:[{Put:{TableName,Item:b}},{Put:{TableName,Item:a,ConditionExpression:'attribute_not_exists(PK)'}}]}))).rejects.toMatchObject({name:'TransactionCanceledException'});
    expect((await store.send(new GetCommand({TableName,Key:b}))).Item).toBeUndefined();
    const command=new TransactWriteCommand({ClientRequestToken:'bulk-token',TransactItems:[{Put:{TableName,Item:b,ConditionExpression:'attribute_not_exists(PK)'}}]});
    await store.send(command);await store.send(command);
    await expect(store.send(new TransactWriteCommand({ClientRequestToken:'bulk-token',TransactItems:[{Delete:{TableName,Key:b}}]}))).rejects.toMatchObject({name:'IdempotentParameterMismatchException'});
    await expect(store.send(new TransactWriteCommand({TransactItems:[{Delete:{TableName,Key:a}},{Delete:{TableName,Key:a}}]}))).rejects.toMatchObject({name:'ValidationException'});
  });
  it('rolls back a multi-command audit chain and refuses mutation while paused',async()=>{
    const a=record('rollback');
    await expect(store.transaction(async()=>{await store.send(new PutCommand({TableName,Item:a}));throw new Error('audit failed');})).rejects.toThrow('audit failed');
    expect((await store.send(new GetCommand({TableName,Key:a}))).Item).toBeUndefined();
    await sql.query("UPDATE olbia.runtime_state SET mode='paused' WHERE id='storage'");
    await expect(store.send(new PutCommand({TableName,Item:a}))).rejects.toMatchObject({name:'MigrationPausedException'});
    await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  });
  it('paginates before filtering, orders GSI keys, supports batch/projection reads and keeps implicit queries complete',async()=>{
    for(let i=0;i<174;i++) await store.send(new PutCommand({TableName,Item:record(`page-${String(i).padStart(3,'0')}`)}));
    const input={TableName,IndexName:'GSI1',KeyConditionExpression:'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',ExpressionAttributeValues:{':pk':'CARDS',':prefix':'page-',':name':'Absent'},ScanIndexForward:false};
    expect((await store.send(new QueryCommand(input))).Items).toHaveLength(174);
    const empty=await store.send(new QueryCommand({...input,Limit:2,FilterExpression:'#name = :name',ExpressionAttributeNames:{'#name':'name'}}));
    expect(empty).toMatchObject({Items:[],Count:0,ScannedCount:2,LastEvaluatedKey:{GSI1SK:'page-172'}});
    const next=await store.send(new QueryCommand({...input,Limit:2,ExclusiveStartKey:empty.LastEvaluatedKey,ProjectionExpression:'PK,SK'}));
    expect(next.Items.map((item:SourceItem)=>item.SK)).toEqual(['CARD#page-171','CARD#page-170']);
    expect((await store.send(new BatchGetCommand({RequestItems:{metadata:{Keys:[{PK:'USER#owner',SK:'CARD#page-001'}],ProjectionExpression:'SK'}}}))).Responses.metadata).toEqual([{SK:'CARD#page-001'}]);
    expect((await store.send(new ScanCommand({TableName,Limit:1,FilterExpression:'PK = :missing',ExpressionAttributeValues:{':missing':'none'}}))).LastEvaluatedKey).toBeDefined();
  });
  it('retries an OCC abort with the entire callback and blocks unknown commands/families',async()=>{
    let attempts=0;const retryPool={...pool,transaction:async<T>(callback:(client:SqlClient)=>Promise<T>)=>{if(++attempts===1) throw Object.assign(new Error('conflict'),{code:'40001'});return pool.transaction(callback);}};
    await new OlbiaSqlStore(retryPool,TableName).send(new PutCommand({TableName,Item:record('retry')}));expect(attempts).toBe(2);
    await expect(store.send(new PutCommand({TableName,Item:{PK:'UNKNOWN',SK:'X'}}))).rejects.toMatchObject({name:'ValidationException'});
    await expect(store.send({input:{TableName}})).rejects.toMatchObject({name:'ValidationException'});
  });
  it('keeps same-transaction reads visible through the shared application context',async()=>{
    const a=record('visible');await pool.transaction(client=>withSqlClient(client,async()=>{await store.send(new PutCommand({TableName,Item:a}));expect((await store.send(new GetCommand({TableName,Key:a}))).Item).toEqual(a);}));
  });
});
describe('checked-in Olbia expression grammar',()=>{
  it('handles legacy claim alternatives, null equality, nested remove, increments and append',()=>{
    const input={ExpressionAttributeNames:{'#payload':'payload','#count':'count'},ExpressionAttributeValues:{':zero':0,':one':1,':next':['next'],':empty':[],':null':null,':from':'a',':to':'z'}};
    expect(conditionMatches('attribute_not_exists(PK) OR (attribute_not_exists(eventId) AND attribute_not_exists(observationId))',{PK:'existing'},input)).toBe(true);
    expect(conditionMatches('PK BETWEEN :from AND :to AND begins_with(PK,:from)',{PK:'apple'},input)).toBe(true);
    expect(conditionMatches('value = :null',{value:null},input)).toBe(true);
    expect(updateItem('SET #count = if_not_exists(#count,:zero) + :one, #payload.items = list_append(if_not_exists(#payload.items,:empty),:next) REMOVE #payload.categoryId',{payload:{categoryId:'old'}},{},input)).toEqual({count:1,payload:{items:['next']}});
    for(const expr of ['ADD count :one','SET payload.missing.deep = :one','SET constructor = :one']) expect(()=>updateItem(expr,{payload:{}},{},input)).toThrow('Unsupported');
    expect(()=>conditionMatches('attribute_not_exists(PK) OR unknown(PK)',undefined,input)).toThrow('Unsupported');
  });
});

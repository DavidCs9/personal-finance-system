import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand, BatchGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createPool } from './connection.js';
import { canonicalJson, entityForKey, projectRows, PROJECTION_VERSION, type SourceItem, type SourceKey } from './model.js';
import { insertRow, sourceHash, type SqlClient, type TransactionPool } from './projection.js';
import { conditionMatches, projectItem, updateItem, type ExpressionInput } from './expressions.js';

type Item=Record<string,unknown>;
type Input=ExpressionInput & Record<string,any>;
type Pool=SqlClient & TransactionPool;
export type StorageAuthority='dynamodb'|'paused'|'sql';
export const sqlStoreEnabled=() => process.env.OLBIA_SQL_STORE_ENABLED==='true';
let pool:ReturnType<typeof createPool>|undefined;
const storePool=():Pool => pool??=createPool(process.env.OLBIA_SQL_STORE_ROLE??'olbia_application');
const context=new AsyncLocalStorage<SqlClient>();
export const withStoreClient=<T>(client:SqlClient,callback:()=>Promise<T>):Promise<T> => context.run(client,callback);
export const applicationStoreClient=():SqlClient => context.getStore()??storePool();
export const currentStoreTransaction=() => context.getStore();
const namedError=(name:string,message:string):Error => Object.assign(new Error(message),{name});
const paused=() => namedError('MigrationPausedException','Olbia está en mantenimiento. Intenta de nuevo más tarde.');

/** Native domain work shares the activation barrier and the connector's OCC retry. */
export const runNativeTransaction=async <T>(pool:TransactionPool,callback:(client:SqlClient)=>Promise<T>):Promise<T> => {
  const existing=context.getStore();if(existing)return callback(existing);
  return pool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    if((await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode!=='sql')throw paused();
    return context.run(client,()=>callback(client));
  });
};
export const withNativeTransaction=async <T>(callback:(client:SqlClient)=>Promise<T>):Promise<T> => {
  const existing=context.getStore();if(existing)return callback(existing);
  try{return await runNativeTransaction(storePool(),callback);}
  catch(error){if((error as {code?:string}).code)throw namedError('StorageUnavailableException','Olbia storage is unavailable.');throw error;}
};
export const authorityFrom = async (client:SqlClient):Promise<StorageAuthority> => {
  const result=await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'");
  const mode=result.rows[0]?.mode;
  if(!['dynamodb','paused','sql'].includes(String(mode))) throw new Error('Missing storage authority.');
  return mode as StorageAuthority;
};
export const storageAuthority=async ():Promise<StorageAuthority> => !sqlStoreEnabled() ? 'dynamodb' : context.getStore() ? 'sql' : authorityFrom(storePool());
export const mutationsPaused=async () => sqlStoreEnabled() && await storageAuthority()==='paused';
export const assertMutationsAvailable=async ():Promise<void> => {if(await mutationsPaused()) throw paused();};
const clean=<T>(value:T):T => JSON.parse(JSON.stringify(value));
const keyOf=(item:Item):SourceKey => {
  if(typeof item.PK!=='string' || typeof item.SK!=='string') throw namedError('ValidationException','Invalid Olbia record key.');
  return {PK:item.PK,SK:item.SK};
};
const keyId=(key:SourceKey) => JSON.stringify([key.PK,key.SK]);
const compare=(a:unknown,b:unknown) => Buffer.compare(Buffer.from(String(a)),Buffer.from(String(b)));
const commandKind=(command:unknown):string => {
  for(const [name,constructor] of Object.entries({GetCommand,PutCommand,UpdateCommand,DeleteCommand,QueryCommand,ScanCommand,BatchGetCommand,TransactWriteCommand})) if(command instanceof constructor) return name;
  throw namedError('ValidationException','Unsupported Olbia storage command.');
};

export class OlbiaSqlStore {
  constructor(readonly pool:Pool, readonly tableName:string) {}
  private checkTable(input:Input) { if(input.TableName!==this.tableName) throw namedError('ValidationException','Unknown Olbia table.'); }
  private async get(client:SqlClient,key:SourceKey):Promise<SourceItem|undefined> {
    const rows=(await client.query('SELECT source_item FROM olbia.projection_state WHERE source_pk=$1 AND source_sk=$2 AND deleted=false',[key.PK,key.SK])).rows;
    return rows[0]?.source_item as SourceItem|undefined;
  }
  private async save(client:SqlClient,key:SourceKey,item:SourceItem|undefined,previous:SourceItem|undefined):Promise<void> {
    if(!entityForKey(key)) throw namedError('ValidationException','Unsupported Olbia record family.');
    if(entityForKey(key)==='categories') throw namedError('ValidationException','The category catalog uses native SQL operations.');
    if(entityForKey(key)==='merchant_category_rules') throw namedError('ValidationException','Merchant rules use native SQL operations.');
    // Deploy this guard before migration 9 copies profiles under the shared
    // application barrier. Older runtimes must not write frozen card evidence.
    if(entityForKey(key)==='cards' && (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=9')).rows.length) {
      throw namedError('MigrationPausedException','La tarjeta se está migrando. Intenta de nuevo en un momento.');
    }
    // Stage this guard before copying native month parents and ordered payments.
    if(entityForKey(key)==='monthly_plans' && (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=11')).rows.length) {
      throw namedError('MigrationPausedException','El plan del mes se está migrando. Intenta de nuevo en un momento.');
    }
    // Stage both halves of legacy CFDI ingestion before native UUID cutover.
    if((entityForKey(key)==='payroll' || key.PK.startsWith('DEDUPE#CFDI_NOMINA#')) &&
      (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=12')).rows.length) {
      throw namedError('MigrationPausedException','La nómina se está migrando. Intenta de nuevo en un momento.');
    }
    // Deploy before migration 13 copies native import captures and ordered rows.
    if(entityForKey(key)==='import_records' && (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=13')).rows.length) {
      throw namedError('MigrationPausedException','Las importaciones se están migrando. Intenta de nuevo en un momento.');
    }
    const family=entityForKey(key);
    if(family==='delivery_records' && (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=17')).rows.length) throw paused();
    if(family==='push_subscriptions' && (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=16')).rows.length) throw paused();
    // Freeze both daily wealth balances and prior captures before migration 15.
    if(['wealth_snapshots','wealth_versions','liability_snapshots','liability_versions'].includes(family??'') &&
      (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows.length) {
      throw paused();
    }
    // Stage the whole ledger boundary before migration 14, including targetless
    // suppression claims and bulk preview/apply/undo state. Tags and MSI freeze
    // through their movement document.
    if((['movements','movement_observations','movement_revisions','bulk_edit_operations'].includes(family??'') ||
      family==='dedupe_claims' && !key.PK.startsWith('DEDUPE#CFDI_NOMINA#')) &&
      (await client.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows.length) {
      throw namedError('MigrationPausedException','Los movimientos se están migrando. Intenta de nuevo en un momento.');
    }
    const rows=projectRows(key,item);
    await client.query(`INSERT INTO olbia.projection_state (source_pk,source_sk,generation,source_hash,source_item,deleted,transformer_version,reconciled_at)
      VALUES ($1,$2,1,$3,$4,$5,$6,CURRENT_TIMESTAMP) ON CONFLICT (source_pk,source_sk) DO UPDATE SET
      generation=olbia.projection_state.generation+1,source_hash=EXCLUDED.source_hash,source_item=EXCLUDED.source_item,
      deleted=EXCLUDED.deleted,transformer_version=EXCLUDED.transformer_version,reconciled_at=CURRENT_TIMESTAMP`,
      [key.PK,key.SK,sourceHash(item),item?JSON.stringify(item):null,!item,PROJECTION_VERSION]);
    // Only modify changed rows: a bulk edit must stay inside native DSQL's 3,000-row transaction limit.
    const identity=(row:ReturnType<typeof projectRows>[number])=>JSON.stringify([row.table,row.values.row_id]);
    const before=new Map(projectRows(key,previous).map(row=>[identity(row),row]));
    for(const row of rows) {
      const prior=before.get(identity(row));before.delete(identity(row));
      if(prior && canonicalJson(prior.values)===canonicalJson(row.values)) continue;
      if(!prior) { await insertRow(client,row);continue; }
      const columns=Object.keys(row.values).filter(column=>!['source_pk','source_sk','row_id'].includes(column));
      await client.query(`UPDATE olbia.${row.table} SET ${columns.map((column,i)=>`${column}=$${i+4}`).join(',')} WHERE source_pk=$1 AND source_sk=$2 AND row_id=$3`,
        [key.PK,key.SK,row.values.row_id,...columns.map(column=>{const value=row.values[column];return value && typeof value==='object'?JSON.stringify(value):value;})]);
    }
    for(const row of before.values()) await client.query(`DELETE FROM olbia.${row.table} WHERE source_pk=$1 AND source_sk=$2 AND row_id=$3`,[key.PK,key.SK,row.values.row_id]);
  }
  async transaction<T>(callback:(client:SqlClient)=>Promise<T>):Promise<T> {
    if(context.getStore()) return callback(context.getStore()!);
    for(let attempt=0;;attempt++) {
      try { return await this.pool.transaction(async client => {
        // One owner and low traffic: this native OCC dependency also serializes
        // competing mutations and the activation/pause barrier, without a lock service.
        await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
        const state=await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'");
        if(state.rows[0]?.mode!=='sql') throw paused();
        return context.run(client,()=>callback(client));
      }); } catch(error) {
        const e=error as {code?:string;constraint?:string};
        if(attempt<4 && (e.code==='40001' || e.code==='23505' && ['projection_state_pkey','command_receipts_pkey'].includes(e.constraint??''))) continue;
        throw error;
      }
    }
  }
  async send(command:unknown):Promise<any> {
    const kind=commandKind(command),input=(command as {input:Input}).input;
    if(kind==='BatchGetCommand') {
      const Responses:Record<string,Item[]>={};
      for(const [table,request] of Object.entries(input.RequestItems as Record<string,Input>)) {
        this.checkTable({TableName:table});Responses[table]=[];
        for(const raw of request.Keys as Item[]) {const item=await this.get(context.getStore()??this.pool,keyOf(raw));if(item) Responses[table].push(projectItem(item,request.ProjectionExpression,request));}
      }
      return {Responses,UnprocessedKeys:{}};
    }
    if(kind==='TransactWriteCommand') return this.transaction(client=>this.writeTransaction(client,input));
    this.checkTable(input);
    if(kind==='GetCommand') { const item=await this.get(context.getStore()??this.pool,keyOf(input.Key));return item?{Item:projectItem(item,input.ProjectionExpression,input)}:{}; }
    if(kind==='QueryCommand' || kind==='ScanCommand') return this.readPage(context.getStore()??this.pool,kind,input);
    return this.transaction(async client=>this.mutate(client,kind,input));
  }
  private async mutate(client:SqlClient,kind:string,input:Input):Promise<any> {
    this.checkTable(input);const key=keyOf(kind==='PutCommand'?input.Item:input.Key);
    const old=await this.get(client,key);
    if(!conditionMatches(input.ConditionExpression,old,input)) throw namedError('ConditionalCheckFailedException','Olbia record precondition failed.');
    const item=kind==='PutCommand'?clean(input.Item):kind==='DeleteCommand'?undefined:kind==='UpdateCommand'?clean(updateItem(input.UpdateExpression,old,key,input)):undefined;
    if(!['PutCommand','DeleteCommand','UpdateCommand'].includes(kind)) throw namedError('ValidationException','Unsupported Olbia mutation.');
    if(item && keyId(keyOf(item))!==keyId(key)) throw namedError('ValidationException','An Olbia record key cannot change.');
    await this.save(client,key,item,old);
    return input.ReturnValues==='ALL_NEW'?{Attributes:item}:input.ReturnValues==='ALL_OLD'?{Attributes:old}:{};
  }
  private async writeTransaction(client:SqlClient,input:Input):Promise<any> {
    const operations=input.TransactItems as Record<string,Input>[];
    if(!Array.isArray(operations) || !operations.length || operations.length>100) throw namedError('ValidationException','Invalid Olbia transaction.');
    const token=input.ClientRequestToken as string|undefined;
    const hash=createHash('sha256').update(canonicalJson(clean(operations))).digest('hex');
    if(token) {
      const receipt=(await client.query('SELECT request_hash,expires_at FROM olbia.command_receipts WHERE token=$1',[token])).rows[0];
      if(receipt && Number(receipt.expires_at)>Date.now()/1000) {
        if(receipt.request_hash!==hash) throw namedError('IdempotentParameterMismatchException','Transaction token was reused for a different request.');
        return {};
      }
    }
    const seen=new Set<string>();
    // Evaluate all conditions before any writes, including ConditionCheck.
    for(const operation of operations) {
      const entries=Object.entries(operation);if(entries.length!==1) throw namedError('ValidationException','Invalid Olbia transaction action.');
      const [kind,action]=entries[0];this.checkTable(action);const key=keyOf(kind==='Put'?action.Item:action.Key);
      if(seen.has(keyId(key))) throw namedError('ValidationException','Duplicate record in Olbia transaction.');seen.add(keyId(key));
      if(!['Put','Update','Delete','ConditionCheck'].includes(kind)) throw namedError('ValidationException','Unsupported Olbia transaction action.');
      if(!conditionMatches(action.ConditionExpression,await this.get(client,key),action)) throw namedError('TransactionCanceledException','Olbia transaction precondition failed.');
      if(kind==='ConditionCheck') await client.query('SELECT generation FROM olbia.projection_state WHERE source_pk=$1 AND source_sk=$2 FOR UPDATE',[key.PK,key.SK]);
    }
    for(const operation of operations) {const [kind,action]=Object.entries(operation)[0];if(kind!=='ConditionCheck') await this.mutate(client,`${kind}Command`,action);}
    if(token) await client.query(`INSERT INTO olbia.command_receipts (token,request_hash,expires_at) VALUES ($1,$2,$3)
      ON CONFLICT (token) DO UPDATE SET request_hash=EXCLUDED.request_hash,expires_at=EXCLUDED.expires_at`,[token,hash,Math.floor(Date.now()/1000)+600]);
    return {};
  }
  private async readPage(client:SqlClient,kind:string,input:Input):Promise<any> {
    const index=input.IndexName as string|undefined;
    if(index && !['GSI1','GSI2','GSI3'].includes(index)) throw namedError('ValidationException','Unknown Olbia index.');
    let statement='SELECT source_item FROM olbia.projection_state WHERE deleted=false',values:unknown[]=[];
    if(kind==='QueryCommand') {
      const expression=String(input.KeyConditionExpression??'');const match=/^\s*([#\w]+)\s*=\s*(:\w+)/.exec(expression);
      if(!match) throw namedError('ValidationException','An Olbia query requires a partition key.');
      const field=match[1].startsWith('#')?input.ExpressionAttributeNames?.[match[1]]:match[1];
      if(field!==(index?`${index}PK`:'PK')) throw namedError('ValidationException','Invalid Olbia partition expression.');
      if(index) {statement+=' AND source_item->>$1=$2';values=[field,input.ExpressionAttributeValues?.[match[2]]];}
      else {statement+=' AND source_pk=$1';values=[input.ExpressionAttributeValues?.[match[2]]];}
    }
    const items=(await client.query(statement,values)).rows.map(row=>row.source_item as SourceItem)
      .filter(item=>!index || typeof item[`${index}SK`]==='string')
      .filter(item=>kind!=='QueryCommand' || conditionMatches(input.KeyConditionExpression,item,input));
    const direction=input.ScanIndexForward===false?-1:1;
    const sort=(a:Item,b:Item):number=>direction*((index?compare(a[`${index}SK`],b[`${index}SK`]):compare(a.SK,b.SK)) || compare(a.PK,b.PK) || compare(a.SK,b.SK));
    // A scan orders by the complete primary key, independent of Query ordering.
    const ordering=kind==='ScanCommand'?(a:Item,b:Item)=>compare(a.PK,b.PK)||compare(a.SK,b.SK):sort;
    items.sort(ordering);
    const remaining=input.ExclusiveStartKey?items.filter(item=>ordering(item,input.ExclusiveStartKey)>0):items;
    const limit=input.Limit??(remaining.length || 1);
    if(!Number.isInteger(limit) || limit<1) throw namedError('ValidationException','Invalid Olbia page size.');
    const page=remaining.slice(0,limit);
    const visible=page.filter(item=>conditionMatches(input.FilterExpression,item,input));
    const last=page.at(-1);const LastEvaluatedKey=remaining.length>page.length && last?{...keyOf(last),...(index?{[`${index}PK`]:last[`${index}PK`],[`${index}SK`]:last[`${index}SK`]}:{})}:undefined;
    return {Items:visible.map(item=>projectItem(item,input.ProjectionExpression,input)),Count:visible.length,ScannedCount:page.length,...(LastEvaluatedKey?{LastEvaluatedKey}:{})};
  }
}

export const withApplicationTransaction=async <T>(callback:()=>Promise<T>):Promise<T> => {
  if(!sqlStoreEnabled() || context.getStore()) return callback();
  const authority=await storageAuthority();if(authority==='dynamodb') return callback();if(authority==='paused') throw paused();
  try { return await new OlbiaSqlStore(storePool(),process.env.METADATA_TABLE_NAME??'').transaction(()=>callback()); }
  catch(error) { if((error as {code?:string}).code) throw namedError('StorageUnavailableException','Olbia storage is unavailable.');throw error; }
};

/** Keep the SDK client identity required by native paginateQuery/paginateScan.
 * Only send is routed; unsupported commands fail closed. No DynamoDB fallback in SQL mode.
 */
export const createApplicationStore=():DynamoDBDocumentClient => {
  const native=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
  if(!sqlStoreEnabled()) return native;
  const send=native.send.bind(native);
  native.send=(async (command:any) => {
    try {
      const kind=commandKind(command),authority=await storageAuthority();
      if(authority==='sql') return await new OlbiaSqlStore(storePool(),process.env.METADATA_TABLE_NAME??'').send(command);
      if(authority==='paused' && !['GetCommand','QueryCommand','ScanCommand','BatchGetCommand'].includes(kind)) throw paused();
      return await send(command);
    } catch(error) {
      const e=error as {name?:string;code?:string};
      if(['MigrationPausedException','ValidationException','ConditionalCheckFailedException','TransactionCanceledException','IdempotentParameterMismatchException'].includes(e.name??'')) throw error;
      throw namedError('StorageUnavailableException','Olbia storage is unavailable.');
    }
  }) as typeof native.send;
  return native;
};

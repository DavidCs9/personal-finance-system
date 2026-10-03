import { PGlite } from '@electric-sql/pglite';
import { DeleteEventCommand, ListEventsCommand, ListSessionsCommand, type BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAssistantThread, getAssistantThread, listAssistantThreads, publicThread, saveAssistantThread, setActiveAssistantThread } from './threads.js';
import { readOperationalItem, readOperationalPartition, selectOperationalRecords, sqlOperationalPartition } from '../operational/reads.js';

let sql: PGlite;
const id='11111111-1111-1111-1111-111111111111';
const record={sessionId:id,title:'Preserved title',firstMonth:'2026-09',createdAt:'2026-09-01T12:00:00Z',updatedAt:'2026-09-02T12:00:00Z'};
const activate=()=>sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP)');
const paused={name:'MigrationPausedException'};
const context=<T>(fn:()=>Promise<T>)=>withStoreClient({query:(s,v)=>sql.query(s,v)},fn);
const dependencies=(databaseSend=vi.fn(async (_command:unknown):Promise<any>=>({})), memorySend=vi.fn(async (_command:unknown):Promise<any>=>({})))=>({
  database:{send:databaseSend} as unknown as DynamoDBDocumentClient,tableName:'metadata',
  memory:{send:memorySend} as unknown as BedrockAgentCoreClient,memoryId:'memory',now:()=>new Date('2026-10-03T00:00:00Z'),
});
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);},30_000);
afterAll(()=>sql.close());
beforeEach(async()=>{vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');await sql.query('DELETE FROM olbia.schema_migrations WHERE version=18');});
afterEach(()=>vi.unstubAllEnvs());

describe('old conversation orchestration activation protection',()=>{
  it('blocks every entry and explicit active clearing before any document/provider IO',async()=>{
    await activate();const databaseSend=vi.fn(),memorySend=vi.fn(),deps=dependencies(databaseSend,memorySend);
    const operations:(()=>Promise<unknown>)[]=[()=>saveAssistantThread(deps,{owner:'owner',sessionId:id,message:'Title',month:'2026-09'}),
      ()=>setActiveAssistantThread(deps,'owner',id),()=>setActiveAssistantThread(deps,'owner',undefined),
      ()=>listAssistantThreads(deps,'owner'),()=>getAssistantThread(deps,'owner',id),()=>deleteAssistantThread(deps,'owner',id)];
    for(const operation of operations)await expect(context(operation)).rejects.toMatchObject(paused);
    expect(databaseSend).not.toHaveBeenCalled();expect(memorySend).not.toHaveBeenCalled();
    expect(publicThread(record)?.title).toBe(record.title);
  });
  it('rechecks a paginated native read and never reads a later page or backfills after activation',async()=>{
    const databaseSend=vi.fn(async(command:unknown)=>command instanceof QueryCommand?{Items:[]} : {});
    const memorySend=vi.fn(async(command:unknown)=>{
      expect(command).toBeInstanceOf(ListSessionsCommand);await activate();return {sessionSummaries:[],nextToken:'next'};
    });
    await expect(context(()=>listAssistantThreads(dependencies(databaseSend,memorySend),'owner'))).rejects.toMatchObject(paused);
    expect(memorySend).toHaveBeenCalledTimes(1);expect(databaseSend).toHaveBeenCalledTimes(1);
  });
  it('rechecks immediately before provider deletion when activation occurs during header lookup',async()=>{
    const databaseSend=vi.fn(async(command:unknown)=>{expect(command).toBeInstanceOf(GetCommand);await activate();return {Item:record};});
    const memorySend=vi.fn(async(command:unknown)=>{
      if(command instanceof ListEventsCommand)return {events:[{eventId:'event-1'}]};
      throw new Error('No provider deletion is permitted after activation');
    });
    await expect(context(()=>deleteAssistantThread(dependencies(databaseSend,memorySend),'owner',id))).rejects.toMatchObject(paused);
    expect(memorySend.mock.calls.some(([command])=>command instanceof DeleteEventCommand)).toBe(false);
    expect(memorySend).toHaveBeenCalledTimes(1);expect(databaseSend).toHaveBeenCalledTimes(1);
  });
  it('rechecks between header save and active selection',async()=>{
    const databaseSend=vi.fn(async(command:unknown)=>{expect(command).toBeInstanceOf(UpdateCommand);await activate();return {Attributes:record};});
    await expect(context(()=>saveAssistantThread(dependencies(databaseSend),{owner:'owner',sessionId:id,message:'Title',month:'2026-09'}))).rejects.toMatchObject(paused);
    expect(databaseSend).toHaveBeenCalledTimes(1);
  });
  it('sanitizes native driver errors and performs no fallback document/provider IO',async()=>{
    const databaseSend=vi.fn(),memorySend=vi.fn();
    await expect(withStoreClient({query:async()=>{throw Object.assign(new Error('private driver details'),{code:'08006'});}},
      ()=>getAssistantThread(dependencies(databaseSend,memorySend),'owner',id))).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
    expect(databaseSend).not.toHaveBeenCalled();expect(memorySend).not.toHaveBeenCalled();
  });
  it('blocks all configured product envelope read modes while retaining independent historical decoding',async()=>{
    await activate();const send=vi.fn(),source=vi.fn(),read=vi.fn(),store=dependencies(send);
    for(const mode of ['dynamodb','shadow','guarded-sql']){
      vi.stubEnv('DSQL_OPERATIONAL_READ_MODE',mode);
      await expect(context(()=>selectOperationalRecords('assistant_threads',source,read))).rejects.toMatchObject(paused);
      await expect(context(()=>readOperationalItem('assistant_threads',store,'USER#owner',`ASSISTANT_THREAD#${id}`))).rejects.toMatchObject(paused);
      await expect(context(()=>readOperationalPartition('assistant_threads',store,'USER#owner','ASSISTANT_THREAD#'))).rejects.toMatchObject(paused);
    }
    await expect(sqlOperationalPartition('assistant_threads','USER#owner','ASSISTANT_THREAD#',{query:(s,v)=>sql.query(s,v)})).rejects.toMatchObject(paused);
    expect(send).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
    expect(publicThread(record)?.id).toBe(id);
  });
});

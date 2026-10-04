import { PGlite } from '@electric-sql/pglite';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from './helpers/migration-schema.js';
import { NATIVE_THREAD_SCHEMA_STATEMENTS, nativeThreadReadGrant, nativeThreadWriteGrants } from '../src/dsql/thread-schema.js';
import { migrateConversationMetadata, prepareThreadCopy } from '../src/dsql/thread-copy.js';
import { CONVERSATION_RETENTION_MS, readConversationMetadata, readConversationIndex, readConversationSelection, upsertConversation, selectConversation, deleteConversationMetadata, expireConversationMetadata } from '../src/dsql/thread.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient, TransactionPool } from '../src/dsql/projection.js';
let sql:PGlite,pool:TransactionPool,store:OlbiaSqlStore;
const id='11111111-1111-1111-1111-111111111111',otherId='22222222-2222-2222-2222-222222222222';
const at='2026-09-01T12:00:00.123Z',later='2026-10-03T12:00:00.456Z';
const expires=Math.floor((Date.parse(at)+CONVERSATION_RETENTION_MS)/1000);
const original={PK:'USER#owner',SK:`ASSISTANT_THREAD#${id}`,entityType:'assistant_thread',owner:'owner',sessionId:id,title:'Original title',firstMonth:'2026-09',createdAt:at,updatedAt:at,expiresAt:expires};
const active={PK:'USER#owner',SK:'ASSISTANT_THREAD#ACTIVE',entityType:'assistant_active_thread',owner:'owner',sessionId:id,updatedAt:later};
const metadata={id,owner:'owner',title:'Original title',firstMonth:'2026-09',createdAt:at,updatedAt:at,expiresAt:new Date(expires*1000).toISOString()};
const snapshot=async()=>Object.fromEntries(await Promise.all(['conversation_threads','assistant_thread_selection','assistant_threads','projection_state','schema_migrations','application_barrier']
  .map(async t=>[t,(await sql.query(`SELECT * FROM olbia.${t} ORDER BY 1`)).rows])));
const save=(owner='owner',threadId=id)=>upsertConversation(sql,{owner,id:threadId,title:'Changed title',month:'2026-10',at:later});
const seed=async()=>{for(const Item of [original,active])await store.send(new PutCommand({TableName:'metadata',Item}));};
beforeAll(async()=>{
  sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,...NATIVE_THREAD_SCHEMA_STATEMENTS])await sql.query(s);
  pool={transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))};store=new OlbiaSqlStore({query:(s,v)=>sql.query(s,v),...pool},'metadata');
  for(const role of ['thread_reader','thread_writer']){await sql.query(`CREATE ROLE ${role}`);await sql.query(`GRANT USAGE ON SCHEMA olbia TO ${role}`);await sql.query(nativeThreadReadGrant(role));}
  for(const s of nativeThreadWriteGrants('thread_writer'))await sql.query(s);
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
beforeEach(async()=>{
  await sql.query('RESET ROLE');await sql.exec('TRUNCATE olbia.assistant_thread_selection,olbia.conversation_threads,olbia.assistant_threads,olbia.projection_state');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=18');await sql.query('INSERT INTO olbia.schema_migrations VALUES (17,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});

it('copies exact headers, active choice and expiry, retains recovery and never recopies after activation',async()=>{
  await seed();const old=(await sql.query('SELECT * FROM olbia.assistant_threads ORDER BY 1,2')).rows;
  await migrateConversationMetadata(pool);expect(await readConversationMetadata(sql,'owner',id)).toEqual(metadata);
  expect(await readConversationSelection(sql,'owner')).toEqual({configured:true,id});
  expect(await readConversationMetadata(sql,'other',id)).toBeUndefined();expect(await readConversationSelection(sql,'other')).toEqual({configured:false});
  expect(await save()).toMatchObject({id,title:original.title,firstMonth:original.firstMonth,createdAt:at,updatedAt:later});
  await sql.transaction(async c=>deleteConversationMetadata(c,'owner',id,later));await migrateConversationMetadata(pool);
  expect(await readConversationMetadata(sql,'owner',id)).toBeUndefined();expect(await readConversationSelection(sql,'owner')).toEqual({configured:true});
  expect((await sql.query('SELECT * FROM olbia.assistant_threads ORDER BY 1,2')).rows).toEqual(old);
});
it('distinguishes missing choice from configured null and atomically saves/selects or rolls back',async()=>{
  expect(await readConversationSelection(sql,'owner')).toEqual({configured:false});await selectConversation(sql,'owner',undefined,at);
  expect(await readConversationSelection(sql,'owner')).toEqual({configured:true});
  const before=await snapshot();await expect(pool.transaction(async c=>{
    await upsertConversation(c,{owner:'owner',id,title:'Title',month:'2026-09',at});await selectConversation(c,'owner',otherId,at);
  })).rejects.toMatchObject({name:'ConversationUnavailableException'});expect(await snapshot()).toEqual(before);
  await pool.transaction(async c=>{await upsertConversation(c,{owner:'owner',id,title:'Title',month:'2026-09',at});await selectConversation(c,'owner',id,at);});
  expect(await readConversationSelection(sql,'owner')).toEqual({configured:true,id});
  await expect(selectConversation(sql,'foreign',undefined,at)).rejects.toMatchObject({name:'ConversationUnavailableException'});
  await expect(selectConversation(sql,'foreign',id,at)).rejects.toMatchObject({name:'ConversationUnavailableException'});
  await expect(save('foreign')).rejects.toMatchObject({name:'ConversationUnavailableException'});
  expect(await readConversationSelection(sql,'owner')).toEqual({configured:true,id});
});
it('constrains singleton selection and actual same-owner parents, and preserves unrelated active choices on deletion',async()=>{
  await seed();await migrateConversationMetadata(pool);await save('owner',otherId);
  await sql.transaction(async c=>deleteConversationMetadata(c,'owner',otherId,later));expect(await readConversationSelection(sql,'owner')).toEqual({configured:true,id});
  await expect(sql.query('UPDATE olbia.assistant_thread_selection SET thread_id=$1',[otherId])).rejects.toMatchObject({code:'23503'});
  await expect(sql.query("UPDATE olbia.assistant_thread_selection SET owner='foreign'")).rejects.toMatchObject({code:'23503'});
  await expect(sql.query("INSERT INTO olbia.assistant_thread_selection VALUES (2,'owner',NULL,CURRENT_TIMESTAMP)")).rejects.toMatchObject({code:'23514'});
  await expect(sql.query('DELETE FROM olbia.conversation_threads WHERE id=$1',[id])).rejects.toMatchObject({code:'23503'});
  const before=await snapshot();await expect(sql.transaction(async c=>{await deleteConversationMetadata(c,'owner',id,later);throw new Error('Interrupted deletion');})).rejects.toThrow('Interrupted deletion');
  expect(await snapshot()).toEqual(before);
});
it('uses exact logical/physical expiry boundaries and clears only expired selected metadata with full rollback',async()=>{
  await seed();await migrateConversationMetadata(pool);await save('owner',otherId);
  const boundary=new Date(expires*1000);expect(await readConversationIndex(sql,'owner',new Date(boundary.getTime()-1))).toHaveLength(2);
  expect((await readConversationIndex(sql,'owner',boundary)).map(r=>r.id)).toEqual([otherId]);
  const before=await snapshot();await expect(pool.transaction(async c=>{expect(await expireConversationMetadata(c,boundary)).toBe(1);throw new Error('Rollback expiry');})).rejects.toThrow('Rollback expiry');
  expect(await snapshot()).toEqual(before);expect(await pool.transaction(c=>expireConversationMetadata(c,boundary))).toBe(1);
  expect(await readConversationSelection(sql,'owner')).toEqual({configured:true});expect(await readConversationMetadata(sql,'owner',otherId)).toBeDefined();
  expect((await sql.query('SELECT * FROM olbia.assistant_threads')).rows).toHaveLength(2);
});
it('enforces actual reader/writer permissions and immutable original metadata fields',async()=>{
  await seed();await migrateConversationMetadata(pool);await sql.query('SET ROLE thread_reader');expect(await readConversationMetadata(sql,'owner',id)).toEqual(metadata);
  await expect(save()).rejects.toMatchObject({code:'42501'});await expect(selectConversation(sql,'owner',undefined,later)).rejects.toMatchObject({code:'42501'});
  await sql.query('SET ROLE thread_writer');expect(await save()).toMatchObject({title:original.title,createdAt:at});
  for(const column of ['id','owner','title','first_month','created_at'])await expect(sql.query(`UPDATE olbia.conversation_threads SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
  for(const column of ['id','owner'])await expect(sql.query(`UPDATE olbia.assistant_thread_selection SET ${column}=${column}`)).rejects.toMatchObject({code:'42501'});
  await expect(sql.query('DELETE FROM olbia.assistant_thread_selection')).rejects.toMatchObject({code:'42501'});
  await sql.transaction(async c=>deleteConversationMetadata(c,'owner',id,later));expect(await readConversationSelection(sql,'owner')).toEqual({configured:true});
});
it('rejects unknown/inconsistent originals, unresolved active selections and partial native state',async()=>{
  await seed();const old=(await sql.query<Record<string,unknown>>('SELECT * FROM olbia.assistant_threads ORDER BY source_sk')).rows;
  const header=old.find(r=>(r.source_item as any).entityType==='assistant_thread')!,selection=old.find(r=>(r.source_item as any).entityType==='assistant_active_thread')!;
  for(const rows of [[{...header,title:'Corruption'}],[{...header,source_item:{...original,extra:'unknown'}}],[{...header,source_item:{...original,expiresAt:1.5}}],
    [{...selection,source_item:{...active,sessionId:otherId}}],[selection],[header,selection,selection]])expect(()=>prepareThreadCopy(rows)).toThrow('inconsistent');
  await save();const before=await snapshot();await expect(migrateConversationMetadata(pool)).rejects.toThrow('inconsistent');expect(await snapshot()).toEqual(before);
});
it('rolls back copied headers/selection, marker and shared barrier on interruption, then retries exactly',async()=>{
  await seed();const before=await snapshot();const failing:TransactionPool={transaction:fn=>sql.transaction(c=>fn({query:async(s,v)=>{
    const result=await c.query<Record<string,unknown>>(s,v);if(s.startsWith('INSERT INTO olbia.assistant_thread_selection'))throw new Error('Interrupted copy');return result;
  }}))};
  await expect(migrateConversationMetadata(failing)).rejects.toThrow('Interrupted copy');expect(await snapshot()).toEqual(before);
  await migrateConversationMetadata(pool);expect(await readConversationMetadata(sql,'owner',id)).toEqual(metadata);expect(await readConversationSelection(sql,'owner')).toEqual({configured:true,id});
});

import {
  ListEventsCommand,
  ListSessionsCommand,
  type BedrockAgentCoreClient,
  type Event,
} from '@aws-sdk/client-bedrock-agentcore';
import { DeleteEventCommand } from '@aws-sdk/client-bedrock-agentcore';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_STATEMENTS } from '@finance/ledger/dsql-schema';
import { withStoreClient } from '@finance/ledger/dsql-store';
import { readConversationMetadata, readConversationSelection } from '@finance/ledger/native-threads';
import { NATIVE_THREAD_SCHEMA_STATEMENTS } from '../../../ledger/src/dsql/thread-schema.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assistantThreadTitle,
  deleteAssistantThread,
  setActiveAssistantThread,
  getAssistantThread,
  listAssistantThreads,
  messagesFromMemoryEvents,
  parseActiveAssistantThreadInput,
  saveAssistantThread,
  visibleUserMessage,
} from './threads.js';

const sessionId = '11111111-1111-1111-1111-111111111111';

const conversationEvent = (
  id: string,
  role: 'USER' | 'ASSISTANT',
  text: string,
  timestamp: string,
): Event => ({
  memoryId: 'OlbiaFinanceMemory-1234567890',
  actorId: 'owner-1',
  sessionId,
  eventId: id,
  eventTimestamp: new Date(timestamp),
  payload: [{ conversational: { role, content: { text } } }],
});

describe('assistant thread presentation', () => {
  it('derives a compact deterministic title without a model call', () => {
    expect(assistantThreadTitle('  ¿Cómo   cierro el mes?  ')).toBe('¿Cómo cierro el mes?');
    expect(assistantThreadTitle('a'.repeat(90))).toBe(`${'a'.repeat(69)}…`);
  });

  it('removes the internal active-month wrapper from restored user messages', () => {
    expect(visibleUserMessage(
      'Contexto: mes activo del selector = 2026-08. Si la pregunta nombra otro mes, ese gana.\n\nPregunta: ¿Cómo cierro?',
    )).toBe('¿Cómo cierro?');
  });

  it('reconstructs only visible user and assistant text in timestamp order', () => {
    const messages = messagesFromMemoryEvents([
      conversationEvent('2#b', 'ASSISTANT', 'Vas a cerrar en $12,000.', '2026-08-27T12:01:00.000Z'),
      conversationEvent(
        '1#a',
        'USER',
        'Contexto: mes activo del selector = 2026-08. Si la pregunta nombra otro mes, ese gana.\n\nPregunta: ¿Cómo cierro?',
        '2026-08-27T12:00:00.000Z',
      ),
    ]);
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: '¿Cómo cierro?' },
      { role: 'assistant', text: 'Vas a cerrar en $12,000.' },
    ]);
  });

  it('unwraps real Harness envelopes without exposing reasoning or tool payloads', () => {
    const harnessEvent = (id: string, role: 'USER' | 'ASSISTANT', message: unknown, timestamp: string): Event => ({
      memoryId: 'OlbiaFinanceMemory-1234567890',
      actorId: 'owner-1',
      sessionId,
      eventId: id,
      eventTimestamp: new Date(timestamp),
      payload: [{ conversational: { role, content: { text: JSON.stringify({ message }) } } }],
    });
    const messages = messagesFromMemoryEvents([
      harnessEvent('1#a', 'USER', {
        role: 'user',
        content: [{ text: 'Contexto: mes activo del selector = 2026-08. Si la pregunta nombra otro mes, ese gana.\n\nPregunta: Hola' }],
      }, '2026-08-27T12:00:00.000Z'),
      harnessEvent('2#b', 'ASSISTANT', {
        role: 'assistant',
        content: [
          { reasoningContent: { reasoningText: { text: 'private chain of thought' } } },
          { text: 'Respuesta visible.' },
          { toolUse: { name: 'month_snapshot', input: { private: true } } },
        ],
      }, '2026-08-27T12:01:00.000Z'),
      harnessEvent('2#c', 'ASSISTANT', {
        role: 'assistant',
        content: [{ text: 'Segundo bloque visible.' }],
      }, '2026-08-27T12:01:01.000Z'),
      harnessEvent('3#d', 'USER', {
        role: 'user',
        content: [{ toolResult: { content: [{ text: '{"private":"tool result"}' }] } }],
      }, '2026-08-27T12:02:00.000Z'),
    ]);
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Hola' },
      { role: 'assistant', text: 'Respuesta visible.\n\nSegundo bloque visible.' },
    ]);
    expect(JSON.stringify(messages)).not.toContain('private chain of thought');
    expect(JSON.stringify(messages)).not.toContain('tool result');
  });
});

let sql:PGlite;
const at='2026-08-27T12:00:00.000Z',now=()=>new Date('2026-10-03T12:00:00Z');
const context=<T>(fn:()=>Promise<T>)=>withStoreClient({query:(s,v)=>sql.query(s,v)},fn);
const dependencies=(send=vi.fn(async(_command:unknown):Promise<any>=>({})))=>({memory:{send} as unknown as BedrockAgentCoreClient,memoryId:'native',now});
const save=(id=sessionId,message='Pregunta visible',activate=true)=>context(()=>saveAssistantThread({now:()=>new Date(at)},{owner:'owner-1',sessionId:id,message,month:'2026-08',activate}));
beforeAll(async()=>{sql=new PGlite();for(const s of [...SCHEMA_STATEMENTS,...NATIVE_THREAD_SCHEMA_STATEMENTS])await sql.query(s);await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');},30_000);
afterAll(()=>sql.close());beforeEach(()=>sql.exec('TRUNCATE olbia.assistant_thread_selection,olbia.conversation_threads'));

describe('native assistant metadata and provider history',()=>{
  it('stores only native metadata and selects it without changing original title/month/creation on refresh',async()=>{
    expect(await save()).toEqual({id:sessionId,title:'Pregunta visible',firstMonth:'2026-08',createdAt:at,updatedAt:at});
    expect(await readConversationSelection(sql,'owner-1')).toEqual({configured:true,id:sessionId});
    expect(await readConversationMetadata(sql,'owner-1',sessionId)).toMatchObject({expiresAt:'2027-08-27T12:00:00.000Z'});
    await context(()=>saveAssistantThread({now},{owner:'owner-1',sessionId,message:'Another title',month:'2026-10'}));
    expect(await readConversationMetadata(sql,'owner-1',sessionId)).toMatchObject({title:'Pregunta visible',firstMonth:'2026-08',createdAt:at,updatedAt:now().toISOString()});
    const columns=(await sql.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema='olbia' AND table_name='conversation_threads'")).rows;
    expect(columns.map(r=>r.column_name)).not.toContain('source_item');
  });
  it('reads native events with authenticated actorId and preserves visible transcript parsing',async()=>{
    await save();const event=conversationEvent('event','USER','Pregunta visible',at);
    const send=vi.fn(async(command:unknown)=>{expect(command).toBeInstanceOf(ListEventsCommand);return{events:[event]};});
    const result=await context(()=>getAssistantThread(dependencies(send),'owner-1',sessionId));expect(result.messages).toHaveLength(1);
    expect((send.mock.calls[0][0] as ListEventsCommand).input).toMatchObject({actorId:'owner-1',sessionId,includePayloads:true});
    expect(result.thread.title).toBe('Pregunta visible');
  });
  it('lists only metadata with native HAS_EVENTS membership without discarding eventless headers',async()=>{
    const stale='22222222-2222-2222-2222-222222222222';await save();await save(stale,'Eventless header',false);
    const send=vi.fn(async(command:unknown)=>{expect(command).toBeInstanceOf(ListSessionsCommand);return{sessionSummaries:[{sessionId}]};});
    const result=await context(()=>listAssistantThreads(dependencies(send),'owner-1'));
    expect(result.threads.map(t=>t.id)).toEqual([sessionId]);expect(result.activeThreadId).toBe(sessionId);
    expect(await readConversationMetadata(sql,'owner-1',stale)).toBeDefined();
    expect((send.mock.calls[0][0] as ListSessionsCommand).input.filter).toEqual({eventFilter:'HAS_EVENTS'});
  });
  it('preserves absent-choice fallback, explicit New Conversation clearing and valid activation',async()=>{
    await save(sessionId,'Title',false);const send=vi.fn(async()=>({sessionSummaries:[{sessionId}]}));
    expect((await context(()=>listAssistantThreads(dependencies(send),'owner-1'))).activeThreadId).toBe(sessionId);
    await context(()=>setActiveAssistantThread({now},'owner-1',undefined));
    expect((await context(()=>listAssistantThreads(dependencies(send),'owner-1'))).activeThreadId).toBeUndefined();
    await context(()=>setActiveAssistantThread({now},'owner-1',sessionId));
    expect((await context(()=>listAssistantThreads(dependencies(send),'owner-1'))).activeThreadId).toBe(sessionId);
    await expect(context(()=>setActiveAssistantThread({now},'foreign',sessionId))).rejects.toThrow('La conversación ya no está disponible.');
  });
  it('paginates provider sessions/events and backfills only missing metadata without overriding active selection',async()=>{
    await save();const missing='22222222-2222-2222-2222-222222222222';
    const send=vi.fn(async(command:unknown)=>{
      if(command instanceof ListSessionsCommand)return command.input.nextToken?{sessionSummaries:[{sessionId:missing,createdAt:new Date(at)}]}:{sessionSummaries:[{sessionId}],nextToken:'sessions-next'};
      if(command instanceof ListEventsCommand)return command.input.nextToken?{events:[conversationEvent('a','ASSISTANT','Answer','2026-09-01T12:01:00Z')]}:{events:[conversationEvent('u','USER','Contexto: mes activo del selector = 2026-09. Context.\n\nPregunta: Recovered title','2026-09-01T12:00:00Z')],nextToken:'events-next'};
      throw new Error('Unexpected mutation');
    });
    const result=await context(()=>listAssistantThreads(dependencies(send),'owner-1'));expect(result.threads.map(t=>t.id)).toEqual([missing,sessionId]);expect(result.activeThreadId).toBe(sessionId);
    expect(await readConversationMetadata(sql,'owner-1',missing)).toMatchObject({title:'Recovered title',firstMonth:'2026-09',updatedAt:'2026-09-01T12:01:00.000Z'});
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('restores an unindexed provider transcript and persists its native metadata/selection',async()=>{
    const send=vi.fn(async()=>({events:[conversationEvent('u','USER','Restored title',at)]}));
    const result=await context(()=>getAssistantThread(dependencies(send),'owner-1',sessionId));expect(result.thread.title).toBe('Restored title');
    expect(await readConversationSelection(sql,'owner-1')).toEqual({configured:true,id:sessionId});
    await expect(context(()=>getAssistantThread(dependencies(),'owner-1','22222222-2222-2222-2222-222222222222'))).rejects.toThrow('La conversación ya no está disponible.');
  });
  it('keeps metadata on provider-delete failure and atomically clears selection after successful provider deletion',async()=>{
    await save();const send=vi.fn(async(command:unknown):Promise<any>=>{
      if(command instanceof ListEventsCommand)return{events:[{eventId:'event-1'}]};
      if(command instanceof DeleteEventCommand)throw new Error('Provider failure');throw new Error('Unexpected command');
    });
    await expect(context(()=>deleteAssistantThread(dependencies(send),'owner-1',sessionId))).rejects.toThrow('Provider failure');
    expect(await readConversationMetadata(sql,'owner-1',sessionId)).toBeDefined();expect(await readConversationSelection(sql,'owner-1')).toEqual({configured:true,id:sessionId});
    send.mockImplementation(async command=>command instanceof ListEventsCommand?{events:[{eventId:'event-1'}]}:{});
    await sql.transaction(c=>withStoreClient(c,()=>deleteAssistantThread(dependencies(send),'owner-1',sessionId)));
    expect(await readConversationMetadata(sql,'owner-1',sessionId)).toBeUndefined();expect(await readConversationSelection(sql,'owner-1')).toEqual({configured:true});
  });
  it('fails closed on SQL outage or before activation with zero provider IO and no source fallback',async()=>{
    const send=vi.fn();const deps=dependencies(send),broken={query:async()=>{throw Object.assign(new Error('private driver error'),{code:'08006'});}};
    const operations:(()=>Promise<unknown>)[]=[()=>listAssistantThreads(deps,'owner-1'),()=>getAssistantThread(deps,'owner-1',sessionId),()=>deleteAssistantThread(deps,'owner-1',sessionId)];
    for(const operation of operations)
      await expect(withStoreClient(broken,operation)).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});
    await sql.query('DELETE FROM olbia.schema_migrations WHERE version=18');
    try{await expect(context(()=>listAssistantThreads(deps,'owner-1'))).rejects.toMatchObject({name:'MigrationPausedException'});await expect(save()).rejects.toMatchObject({name:'MigrationPausedException'});}
    finally{await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP)');}
    expect(send).not.toHaveBeenCalled();
  });
  it('accepts explicit empty active selection and rejects malformed ids before IO',()=>{
    expect(parseActiveAssistantThreadInput('{"threadId":null}')).toBeUndefined();expect(()=>parseActiveAssistantThreadInput('{"threadId":"short"}')).toThrow('threadId no es válido');
  });
});

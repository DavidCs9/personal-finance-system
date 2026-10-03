import { applicationSqlClient, withSqlTransaction } from '@finance/ledger/sql-runtime';
import { isConversationId, conversationPresentation, readConversationMetadata, readConversationIndex, readConversationSelection, upsertConversation, selectConversation, deleteConversationMetadata } from '@finance/ledger/native-threads';
import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  type Event,
} from '@aws-sdk/client-bedrock-agentcore';

const DEFAULT_VISIBLE_THREADS = 20;
const MAX_VISIBLE_THREADS = 20;

const DELETE_EVENT_CONCURRENCY = 8;

export type AssistantThread = {
  readonly id: string;
  readonly title: string;
  readonly firstMonth: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AssistantThreadMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: string;
};

type StoreDependencies = { readonly now?: () => Date };

type HistoryDependencies = StoreDependencies & {
  readonly memory: BedrockAgentCoreClient;
  readonly memoryId: string;
};

export class InvalidAssistantThreadError extends Error {}

export const isValidAssistantThreadId = isConversationId;

export const assistantThreadTitle = (message: string): string => {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Nueva conversación';
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}…`;
};

const unavailableStorage = () => Object.assign(new Error('Olbia storage is unavailable.'), { name:'StorageUnavailableException' });
const assertNativeThreadsActive = async (client:ReturnType<typeof applicationSqlClient>):Promise<void> => {
  if (!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=18')).rows.length)
    throw Object.assign(new Error('Olbia está en mantenimiento. Intenta de nuevo más tarde.'),{name:'MigrationPausedException'});
};
const readMetadata = async <T>(operation: () => Promise<T>): Promise<T> => {
  try { await assertNativeThreadsActive(applicationSqlClient()); return await operation(); }
  catch (error) { if ((error as Error).name === 'MigrationPausedException') throw error; throw unavailableStorage(); }
};
const writeMetadata = async <T>(operation: Parameters<typeof withSqlTransaction<T>>[0]): Promise<T> => {
  try { return await withSqlTransaction(async client => { await assertNativeThreadsActive(client); return operation(client); }); }
  catch (error) {
    if ((error as Error).name === 'ConversationUnavailableException') throw new InvalidAssistantThreadError('La conversación ya no está disponible.');
    if ((error as {code?:string}).code) throw unavailableStorage();
    throw error;
  }
};
// The read-only verifier uses these actual product metadata adapters without provider IO or backfill.
export const readStoredConversation = (owner:string,id:string) => readMetadata(() => readConversationMetadata(applicationSqlClient(),owner,id));
export const readStoredConversationIndex = (owner:string,at:Date) => readMetadata(() => readConversationIndex(applicationSqlClient(),owner,at));
export const readStoredConversationSelection = (owner:string) => readMetadata(() => readConversationSelection(applicationSqlClient(),owner));

export const saveAssistantThread = async (
  dependencies: StoreDependencies,
  input: { readonly owner:string; readonly sessionId:string; readonly message:string; readonly month:string; readonly activate?:boolean },
): Promise<AssistantThread> => {
  if (!isValidAssistantThreadId(input.sessionId)) throw new InvalidAssistantThreadError('La conversación no es válida.');
  const at = (dependencies.now?.() ?? new Date()).toISOString();
  return writeMetadata(async client => {
    const thread = await upsertConversation(client,{owner:input.owner,id:input.sessionId,title:assistantThreadTitle(input.message),month:input.month,at});
    if (input.activate !== false) await selectConversation(client,input.owner,input.sessionId,at);
    return thread;
  });
};

export const setActiveAssistantThread = async (dependencies:StoreDependencies,owner:string,sessionId:string|undefined):Promise<void> => {
  if (sessionId !== undefined && !isValidAssistantThreadId(sessionId)) throw new InvalidAssistantThreadError('La conversación no es válida.');
  const at = (dependencies.now?.() ?? new Date()).toISOString();
  await writeMetadata(client => selectConversation(client,owner,sessionId,at));
};

const allMemoryEvents = async (
  dependencies: Pick<HistoryDependencies, 'memory' | 'memoryId'>,
  owner: string,
  sessionId: string,
): Promise<Event[]> => {
  const events: Event[] = [];
  let nextToken: string | undefined;
  do {
    const page = await dependencies.memory.send(new ListEventsCommand({
      memoryId: dependencies.memoryId,
      actorId: owner,
      sessionId,
      includePayloads: true,
      maxResults: 100,
      nextToken,
    }));
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return events.sort((left, right) => {
    const time = (left.eventTimestamp?.getTime() ?? 0) - (right.eventTimestamp?.getTime() ?? 0);
    return time || String(left.eventId ?? '').localeCompare(String(right.eventId ?? ''));
  });
};

export const visibleUserMessage = (text: string): string => {
  const marker = '\n\nPregunta: ';
  if (text.startsWith('Contexto: mes activo del selector = ') && text.includes(marker)) {
    return text.slice(text.indexOf(marker) + marker.length).trim();
  }
  return text.trim();
};

type VisibleConversationPayload = {
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

const visibleConversationPayload = (
  conversational: NonNullable<NonNullable<Event['payload']>[number]['conversational']>,
): VisibleConversationPayload | undefined => {
  const rawText = conversational.content && 'text' in conversational.content
    ? conversational.content.text
    : undefined;
  if (typeof rawText !== 'string') return undefined;

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const message = parsed.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
    const body = message as Record<string, unknown>;
    const role = body.role === 'user'
      ? 'user'
      : body.role === 'assistant'
        ? 'assistant'
        : conversational.role === 'USER'
          ? 'user'
          : conversational.role === 'ASSISTANT'
            ? 'assistant'
            : undefined;
    if (!role || !Array.isArray(body.content)) return undefined;
    const text = body.content.flatMap((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
      const value = (block as Record<string, unknown>).text;
      return typeof value === 'string' && value.trim() ? [value.trim()] : [];
    }).join('\n\n');
    return text ? { role, text } : undefined;
  } catch {
    const role = conversational.role === 'USER'
      ? 'user'
      : conversational.role === 'ASSISTANT'
        ? 'assistant'
        : undefined;
    return role ? { role, text: rawText.trim() } : undefined;
  }
};

const monthFromMemoryEvents = (events: readonly Event[]): string | undefined => {
  for (const event of events) {
    for (const payload of event.payload ?? []) {
      const visible = payload.conversational
        ? visibleConversationPayload(payload.conversational)
        : undefined;
      const match = visible?.role === 'user'
        ? /^Contexto: mes activo del selector = (\d{4}-(?:0[1-9]|1[0-2]))\./.exec(visible.text)
        : undefined;
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
};

export const messagesFromMemoryEvents = (events: readonly Event[]): AssistantThreadMessage[] => {
  const messages: AssistantThreadMessage[] = [];
  const orderedEvents = [...events].sort((left, right) => {
    const time = (left.eventTimestamp?.getTime() ?? 0) - (right.eventTimestamp?.getTime() ?? 0);
    return time || String(left.eventId ?? '').localeCompare(String(right.eventId ?? ''));
  });
  for (const event of orderedEvents) {
    for (let payloadIndex = 0; payloadIndex < (event.payload?.length ?? 0); payloadIndex += 1) {
      const conversational = event.payload?.[payloadIndex]?.conversational;
      const visible = conversational ? visibleConversationPayload(conversational) : undefined;
      if (!visible) continue;
      const { role } = visible;
      const text = role === 'user' ? visibleUserMessage(visible.text) : visible.text;
      if (!text) continue;
      const previous = messages[messages.length - 1];
      if (previous?.role === role && previous.text === text) continue;
      if (previous?.role === 'assistant' && role === 'assistant') {
        messages[messages.length - 1] = {
          ...previous,
          text: `${previous.text}\n\n${text}`,
        };
        continue;
      }
      messages.push({
        id: `${event.eventId ?? 'event'}-${payloadIndex}`,
        role,
        text,
        createdAt: (event.eventTimestamp ?? new Date(0)).toISOString(),
      });
    }
  }
  return messages;
};

export const getAssistantThread = async (
  dependencies: HistoryDependencies,
  owner: string,
  sessionId: string,
): Promise<{ readonly thread: AssistantThread; readonly messages: readonly AssistantThreadMessage[] }> => {
  if (!isValidAssistantThreadId(sessionId)) throw new InvalidAssistantThreadError('La conversación no es válida.');
  const existing = await readStoredConversation(owner,sessionId);
  const events = await allMemoryEvents(dependencies, owner, sessionId);
  const messages = messagesFromMemoryEvents(events);
  let thread = existing ? conversationPresentation(existing) : undefined;
  if (!thread) {
    const firstUser = messages.find((message) => message.role === 'user');
    if (!firstUser) throw new InvalidAssistantThreadError('La conversación ya no está disponible.');
    thread = await saveAssistantThread(dependencies, {
      owner,
      sessionId,
      message: firstUser.text,
      month: monthFromMemoryEvents(events) ?? firstUser.createdAt.slice(0, 7),
    });
  }
  return { thread, messages };
};

export const listAssistantThreads = async (
  dependencies: HistoryDependencies,
  owner: string,
  limit = DEFAULT_VISIBLE_THREADS,
): Promise<{ readonly threads: readonly AssistantThread[]; readonly activeThreadId?: string }> => {
  const boundedLimit = Math.max(1, Math.min(MAX_VISIBLE_THREADS, Math.trunc(limit)));
  const indexed = await readStoredConversationIndex(owner,dependencies.now?.() ?? new Date());
  const byId = new Map(indexed.map((thread) => [thread.id, thread]));
  let nextToken: string | undefined;
  const nativeSessions: { id: string; createdAt: Date }[] = [];
  do {
    const page = await dependencies.memory.send(new ListSessionsCommand({
      memoryId: dependencies.memoryId,
      actorId: owner,
      filter: { eventFilter: 'HAS_EVENTS' },
      maxResults: 100,
      nextToken,
    }));
    for (const session of page.sessionSummaries ?? []) {
      if (session.sessionId && isValidAssistantThreadId(session.sessionId)) {
        nativeSessions.push({ id: session.sessionId, createdAt: session.createdAt ?? new Date(0) });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);

  const nativeSessionIds = new Set(nativeSessions.map((session) => session.id));
  for (const threadId of byId.keys()) {
    if (!nativeSessionIds.has(threadId)) byId.delete(threadId);
  }

  const missing = nativeSessions
    .filter((session) => !byId.has(session.id))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, boundedLimit);
  for (let index = 0; index < missing.length; index += 4) {
    const batch = missing.slice(index, index + 4);
    await Promise.all(batch.map(async (session) => {
      const events = await allMemoryEvents(dependencies, owner, session.id);
      const messages = messagesFromMemoryEvents(events);
      const firstUser = messages.find((message) => message.role === 'user');
      if (!firstUser) return;
      const lastMessage = messages[messages.length - 1];
      const thread = await saveAssistantThread({
        ...dependencies,
        now: () => new Date(lastMessage?.createdAt ?? session.createdAt),
      }, {
        owner,
        sessionId: session.id,
        message: firstUser.text,
        month: monthFromMemoryEvents(events) ?? firstUser.createdAt.slice(0, 7),
        activate: false,
      });
      byId.set(thread.id, thread);
    }));
  }

  const threads = [...byId.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, boundedLimit);
  const active = await readStoredConversationSelection(owner);
  const selectedActive = active.configured
    ? active.id && threads.some((thread) => thread.id === active.id) ? active.id : undefined
    : threads[0]?.id;
  return { threads, ...(selectedActive ? { activeThreadId:selectedActive } : {}) };
};

export const deleteAssistantThread = async (
  dependencies: HistoryDependencies,
  owner: string,
  sessionId: string,
): Promise<void> => {
  if (!isValidAssistantThreadId(sessionId)) throw new InvalidAssistantThreadError('La conversación no es válida.');
  const indexed = await readStoredConversation(owner,sessionId);
  const events = await allMemoryEvents(dependencies, owner, sessionId);
  if (events.length === 0 && !indexed) throw new InvalidAssistantThreadError('La conversación ya no está disponible.');
  for (let index = 0; index < events.length; index += DELETE_EVENT_CONCURRENCY) {
    await Promise.all(events.slice(index, index + DELETE_EVENT_CONCURRENCY).map(async (event) => {
      if (!event.eventId) return;
      await dependencies.memory.send(new DeleteEventCommand({
        memoryId: dependencies.memoryId,
        actorId: owner,
        sessionId,
        eventId: event.eventId,
      }));
    }));
  }
  const at = (dependencies.now?.() ?? new Date()).toISOString();
  await writeMetadata(client => deleteConversationMetadata(client,owner,sessionId,at));
};

export const parseActiveAssistantThreadInput = (raw: string | undefined): string | undefined => {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new InvalidAssistantThreadError('El body debe ser JSON válido.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidAssistantThreadError('El body debe ser un objeto JSON.');
  }
  const threadId = (parsed as Record<string, unknown>).threadId;
  if (threadId === null) return undefined;
  if (typeof threadId !== 'string' || !isValidAssistantThreadId(threadId)) {
    throw new InvalidAssistantThreadError('threadId no es válido.');
  }
  return threadId;
};

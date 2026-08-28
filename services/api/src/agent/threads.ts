import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  type Event,
} from '@aws-sdk/client-bedrock-agentcore';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const THREAD_PREFIX = 'ASSISTANT_THREAD#';
const ACTIVE_THREAD_SK = `${THREAD_PREFIX}ACTIVE`;
const DEFAULT_VISIBLE_THREADS = 20;
const MAX_VISIBLE_THREADS = 20;
const EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
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

type StoreDependencies = {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now?: () => Date;
};

type HistoryDependencies = StoreDependencies & {
  readonly memory: BedrockAgentCoreClient;
  readonly memoryId: string;
};

export class InvalidAssistantThreadError extends Error {}

export const isValidAssistantThreadId = (value: string): boolean =>
  value.length >= 33 && value.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);

const userPk = (owner: string): string => `USER#${owner}`;
const threadKey = (owner: string, sessionId: string) => ({
  PK: userPk(owner),
  SK: `${THREAD_PREFIX}${sessionId}`,
});
const activeThreadKey = (owner: string) => ({ PK: userPk(owner), SK: ACTIVE_THREAD_SK });

export const assistantThreadTitle = (message: string): string => {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Nueva conversación';
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}…`;
};

const publicThread = (item: Record<string, unknown>): AssistantThread | undefined => {
  if (
    typeof item.sessionId !== 'string'
    || !isValidAssistantThreadId(item.sessionId)
    || typeof item.title !== 'string'
    || typeof item.firstMonth !== 'string'
    || typeof item.createdAt !== 'string'
    || typeof item.updatedAt !== 'string'
  ) return undefined;
  return {
    id: item.sessionId,
    title: item.title,
    firstMonth: item.firstMonth,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

export const saveAssistantThread = async (
  dependencies: StoreDependencies,
  input: {
    readonly owner: string;
    readonly sessionId: string;
    readonly message: string;
    readonly month: string;
    readonly activate?: boolean;
  },
): Promise<AssistantThread> => {
  if (!isValidAssistantThreadId(input.sessionId)) {
    throw new InvalidAssistantThreadError('La conversación no es válida.');
  }
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const expiresAt = Math.floor((new Date(now).getTime() + EVENT_RETENTION_MS) / 1000);
  const result = await dependencies.database.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: threadKey(input.owner, input.sessionId),
    UpdateExpression: [
      'SET entityType = :entityType',
      '#owner = :owner',
      'sessionId = :sessionId',
      'title = if_not_exists(title, :title)',
      'firstMonth = if_not_exists(firstMonth, :month)',
      'createdAt = if_not_exists(createdAt, :now)',
      'updatedAt = :now',
      'expiresAt = :expiresAt',
    ].join(', '),
    ExpressionAttributeNames: {
      '#owner': 'owner',
    },
    ExpressionAttributeValues: {
      ':entityType': 'assistant_thread',
      ':owner': input.owner,
      ':sessionId': input.sessionId,
      ':title': assistantThreadTitle(input.message),
      ':month': input.month,
      ':now': now,
      ':expiresAt': expiresAt,
    },
    ReturnValues: 'ALL_NEW',
  }));
  if (input.activate !== false) {
    await setActiveAssistantThread(dependencies, input.owner, input.sessionId);
  }
  const thread = result.Attributes ? publicThread(result.Attributes) : undefined;
  if (!thread) throw new Error('No se pudo guardar la conversación.');
  return thread;
};

export const setActiveAssistantThread = async (
  dependencies: StoreDependencies,
  owner: string,
  sessionId: string | undefined,
): Promise<void> => {
  if (sessionId !== undefined && !isValidAssistantThreadId(sessionId)) {
    throw new InvalidAssistantThreadError('La conversación no es válida.');
  }
  if (!sessionId) {
    await dependencies.database.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: {
        ...activeThreadKey(owner),
        entityType: 'assistant_active_thread',
        owner,
        sessionId: null,
        updatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      },
    }));
    return;
  }
  const existing = await dependencies.database.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: threadKey(owner, sessionId),
    ConsistentRead: true,
  }));
  if (!existing.Item) throw new InvalidAssistantThreadError('La conversación ya no está disponible.');
  await dependencies.database.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: {
      ...activeThreadKey(owner),
      entityType: 'assistant_active_thread',
      owner,
      sessionId,
      updatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    },
  }));
};

const indexedThreads = async (dependencies: StoreDependencies, owner: string): Promise<AssistantThread[]> => {
  const threads: AssistantThread[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dependencies.database.send(new QueryCommand({
      TableName: dependencies.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(owner), ':prefix': THREAD_PREFIX },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    for (const item of page.Items ?? []) {
      if (item.SK === ACTIVE_THREAD_SK) continue;
      const thread = publicThread(item);
      if (thread) threads.push(thread);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return threads;
};

const activeThreadSelection = async (
  dependencies: StoreDependencies,
  owner: string,
): Promise<{ readonly configured: boolean; readonly id?: string }> => {
  const result = await dependencies.database.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: activeThreadKey(owner),
    ConsistentRead: true,
  }));
  if (!result.Item) return { configured: false };
  return typeof result.Item.sessionId === 'string' && isValidAssistantThreadId(result.Item.sessionId)
    ? { configured: true, id: result.Item.sessionId }
    : { configured: true };
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
  const events = await allMemoryEvents(dependencies, owner, sessionId);
  const messages = messagesFromMemoryEvents(events);
  const existing = await dependencies.database.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: threadKey(owner, sessionId),
    ConsistentRead: true,
  }));
  let thread = existing.Item ? publicThread(existing.Item) : undefined;
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
  const cutoff = (dependencies.now?.() ?? new Date()).getTime() - EVENT_RETENTION_MS;
  const indexed = (await indexedThreads(dependencies, owner))
    .filter((thread) => new Date(thread.updatedAt).getTime() >= cutoff);
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
  const active = await activeThreadSelection(dependencies, owner);
  const selectedActive = active.configured
    ? active.id && threads.some((thread) => thread.id === active.id) ? active.id : undefined
    : threads[0]?.id;
  return { threads, ...(selectedActive ? { activeThreadId: selectedActive } : {}) };
};

export const deleteAssistantThread = async (
  dependencies: HistoryDependencies,
  owner: string,
  sessionId: string,
): Promise<void> => {
  if (!isValidAssistantThreadId(sessionId)) throw new InvalidAssistantThreadError('La conversación no es válida.');
  const events = await allMemoryEvents(dependencies, owner, sessionId);
  const indexed = await dependencies.database.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: threadKey(owner, sessionId),
    ConsistentRead: true,
  }));
  if (events.length === 0 && !indexed.Item) {
    throw new InvalidAssistantThreadError('La conversación ya no está disponible.');
  }
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
  await dependencies.database.send(new DeleteCommand({
    TableName: dependencies.tableName,
    Key: threadKey(owner, sessionId),
  }));
  const active = await activeThreadSelection(dependencies, owner);
  if (active.id === sessionId) await setActiveAssistantThread(dependencies, owner, undefined);
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

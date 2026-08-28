import {
  ListEventsCommand,
  ListSessionsCommand,
  type BedrockAgentCoreClient,
  type Event,
} from '@aws-sdk/client-bedrock-agentcore';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  assistantThreadTitle,
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

describe('assistant thread persistence', () => {
  it('stores only thread metadata and selects it as active', async () => {
    const record = {
      sessionId,
      title: '¿Cómo cierro el mes?',
      firstMonth: '2026-08',
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateCommand) return { Attributes: record };
      if (command instanceof GetCommand) return { Item: record };
      if (command instanceof PutCommand) return {};
      throw new Error(`Unexpected command ${String(command)}`);
    });
    const thread = await saveAssistantThread({
      database: { send } as unknown as DynamoDBDocumentClient,
      tableName: 'metadata',
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    }, {
      owner: 'owner-1',
      sessionId,
      message: '¿Cómo cierro el mes?',
      month: '2026-08',
    });
    expect(thread).toEqual({
      id: sessionId,
      title: record.title,
      firstMonth: record.firstMonth,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    const update = send.mock.calls.find(([command]) => command instanceof UpdateCommand)?.[0] as UpdateCommand;
    expect(update.input.Key).toEqual({ PK: 'USER#owner-1', SK: `ASSISTANT_THREAD#${sessionId}` });
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':owner': 'owner-1',
      ':sessionId': sessionId,
      ':title': '¿Cómo cierro el mes?',
      ':expiresAt': 1819368000,
    });
    expect(update.input).toMatchObject({
      ExpressionAttributeNames: { '#owner': 'owner' },
    });
    expect(JSON.stringify(update.input)).not.toContain('transcript');
  });

  it('reads AgentCore events with the authenticated owner as actorId', async () => {
    const event = conversationEvent('1#a', 'USER', 'Pregunta visible', '2026-08-27T12:00:00.000Z');
    const memorySend = vi.fn(async (command: unknown) => {
      if (command instanceof ListEventsCommand) return { events: [event] };
      throw new Error('Unexpected memory command');
    });
    const databaseSend = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return {
        Item: {
          sessionId,
          title: 'Pregunta visible',
          firstMonth: '2026-08',
          createdAt: '2026-08-27T12:00:00.000Z',
          updatedAt: '2026-08-27T12:00:00.000Z',
        },
      };
      throw new Error('Unexpected database command');
    });
    const result = await getAssistantThread({
      database: { send: databaseSend } as unknown as DynamoDBDocumentClient,
      tableName: 'metadata',
      memory: { send: memorySend } as unknown as BedrockAgentCoreClient,
      memoryId: 'OlbiaFinanceMemory-1234567890',
    }, 'owner-1', sessionId);
    expect(result.messages).toHaveLength(1);
    const command = memorySend.mock.calls[0]?.[0] as ListEventsCommand;
    expect(command.input).toMatchObject({ actorId: 'owner-1', sessionId, includePayloads: true });
  });

  it('lists only indexed threads that still have native AgentCore events', async () => {
    const staleSessionId = '22222222-2222-2222-2222-222222222222';
    const record = {
      sessionId,
      title: 'Conversación vigente',
      firstMonth: '2026-08',
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:02:00.000Z',
    };
    const databaseSend = vi.fn(async (command: unknown) => {
      if (command instanceof QueryCommand) return {
        Items: [
          { ...record, PK: 'USER#owner-1', SK: `ASSISTANT_THREAD#${sessionId}` },
          {
            ...record,
            sessionId: staleSessionId,
            title: 'Conversación expirada',
            PK: 'USER#owner-1',
            SK: `ASSISTANT_THREAD#${staleSessionId}`,
          },
        ],
      };
      if (command instanceof GetCommand) return { Item: { sessionId } };
      throw new Error('Unexpected database command');
    });
    const memorySend = vi.fn(async (command: unknown) => {
      if (command instanceof ListSessionsCommand) return {
        sessionSummaries: [{ sessionId, actorId: 'owner-1', createdAt: new Date(record.createdAt) }],
      };
      throw new Error('Unexpected memory command');
    });
    const result = await listAssistantThreads({
      database: { send: databaseSend } as unknown as DynamoDBDocumentClient,
      tableName: 'metadata',
      memory: { send: memorySend } as unknown as BedrockAgentCoreClient,
      memoryId: 'OlbiaFinanceMemory-1234567890',
      now: () => new Date('2026-08-27T13:00:00.000Z'),
    }, 'owner-1');
    expect(result).toEqual({ threads: [{
      id: sessionId,
      title: record.title,
      firstMonth: record.firstMonth,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }], activeThreadId: sessionId });
    const command = memorySend.mock.calls[0]?.[0] as ListSessionsCommand;
    expect(command.input).toMatchObject({ actorId: 'owner-1', filter: { eventFilter: 'HAS_EVENTS' } });
  });

  it('accepts an explicit empty active selection and rejects malformed ids', () => {
    expect(parseActiveAssistantThreadInput('{"threadId":null}')).toBeUndefined();
    expect(() => parseActiveAssistantThreadInput('{"threadId":"short"}')).toThrow('threadId no es válido');
  });
});

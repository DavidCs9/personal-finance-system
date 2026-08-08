import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { principal } from '../http/response.js';
import { resolveRuntimePrompt } from './prompt-runtime.js';

const harnessArn = process.env.HARNESS_ARN?.trim();
const agentcore = new BedrockAgentCoreClient({});

type SseEvent =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'citation'; readonly kind: string; readonly id?: string; readonly label: string }
  | { readonly type: 'proposal'; readonly eventId: string; readonly categoryId: string; readonly message: string }
  | { readonly type: 'done'; readonly requestId: string; readonly sessionId: string }
  | { readonly type: 'error'; readonly message: string; readonly requestId: string };

const sse = (event: SseEvent): string => `data: ${JSON.stringify(event)}\n\n`;

const parseBody = (raw: string | undefined): {
  message: string;
  month: string;
  sessionId: string;
} => {
  let parsed: Record<string, unknown> = {};
  if (raw?.trim()) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('Body JSON inválido.');
    }
  }
  const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  const month = typeof parsed.month === 'string' ? parsed.month : '';
  if (!message) throw new Error('message es obligatorio.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('month debe ser YYYY-MM.');
  const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.length >= 33
    ? parsed.sessionId
    : randomUUID();
  return { message, month, sessionId };
};

const isTransient = (error: unknown): boolean => {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name: string }).name)
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return /throttl|timeout|temporar|429|503|ECONNRESET/i.test(`${name} ${message}`);
};

const citationsFromPayload = (data: Record<string, unknown>): SseEvent[] => {
  const out: SseEvent[] = [];
  if (Array.isArray(data.movements)) {
    for (const row of (data.movements as { id?: string; merchantRaw?: string }[]).slice(0, 8)) {
      if (row.merchantRaw) {
        out.push({ type: 'citation', kind: 'movement', id: row.id, label: row.merchantRaw });
      }
    }
  }
  if (data.month && data.summary) {
    out.push({ type: 'citation', kind: 'summary', label: `Resumen ${String(data.month)}` });
  }
  if (data.netMxnMinor !== undefined) {
    out.push({ type: 'citation', kind: 'wealth', label: 'Patrimonio' });
  }
  return out;
};

const tryParseJsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore partial JSON while streaming
  }
  return undefined;
};

async function* invokeHarnessStream(
  owner: string,
  month: string,
  userMessage: string,
  sessionId: string,
): AsyncGenerator<SseEvent> {
  if (!harnessArn) {
    throw new Error('HARNESS_ARN no configurado: el proxy solo habla con AgentCore Harness.');
  }

  // Prompt Management is the runtime source of truth (SSM pointer → versioned prompt).
  // Override on every invoke so promote/rollback does not require UpdateHarness or redeploy.
  const prompt = await resolveRuntimePrompt();

  const response = await agentcore.send(new InvokeHarnessCommand({
    harnessArn,
    runtimeSessionId: sessionId,
    runtimeUserId: owner,
    systemPrompt: [{ text: prompt.text }],
    model: {
      bedrockModelConfig: {
        modelId: prompt.modelId,
        maxTokens: prompt.maxTokens,
        temperature: prompt.temperature,
        topP: prompt.topP,
        apiFormat: 'converse_stream',
      },
    },
    messages: [{
      role: 'user',
      content: [{
        text: `Contexto: mes activo del selector = ${month}. Si la pregunta nombra otro mes, ese gana.\n\nPregunta: ${userMessage}`,
      }],
    }],
  }));

  const toolUseByIndex = new Map<number, { name: string; inputJson: string }>();

  for await (const event of response.stream ?? []) {
    if (event.contentBlockDelta?.delta?.text) {
      yield { type: 'token', text: event.contentBlockDelta.delta.text };
    }

    const startToolUse = event.contentBlockStart?.start?.toolUse;
    if (startToolUse && event.contentBlockStart?.contentBlockIndex !== undefined) {
      toolUseByIndex.set(event.contentBlockStart.contentBlockIndex, {
        name: startToolUse.name ?? '',
        inputJson: '',
      });
    }

    const toolUseDelta = event.contentBlockDelta?.delta?.toolUse;
    if (toolUseDelta?.input && event.contentBlockDelta?.contentBlockIndex !== undefined) {
      const current = toolUseByIndex.get(event.contentBlockDelta.contentBlockIndex);
      if (current) {
        current.inputJson += toolUseDelta.input;
      }
    }

    if (event.contentBlockStop?.contentBlockIndex !== undefined) {
      const finished = toolUseByIndex.get(event.contentBlockStop.contentBlockIndex);
      if (finished?.name === 'propose_recategorize') {
        const input = tryParseJsonObject(finished.inputJson);
        const eventId = typeof input?.eventId === 'string' ? input.eventId : '';
        const categoryId = typeof input?.categoryId === 'string' ? input.categoryId : '';
        if (eventId && categoryId) {
          yield {
            type: 'proposal',
            eventId,
            categoryId,
            message: `Confirma recategorizar ${eventId} a ${categoryId}.`,
          };
        }
      }
      toolUseByIndex.delete(event.contentBlockStop.contentBlockIndex);
    }

    const toolResultDeltas = event.contentBlockDelta?.delta?.toolResult;
    if (Array.isArray(toolResultDeltas)) {
      for (const block of toolResultDeltas) {
        if (block.json && typeof block.json === 'object' && !Array.isArray(block.json)) {
          yield* citationsFromPayload(block.json as Record<string, unknown>);
        } else if (typeof block.text === 'string') {
          const parsed = tryParseJsonObject(block.text);
          if (parsed) yield* citationsFromPayload(parsed);
        }
      }
    }

    if (event.validationException || event.internalServerException || event.runtimeClientError) {
      const detail = event.validationException?.message
        ?? event.internalServerException?.message
        ?? event.runtimeClientError?.message
        ?? 'Error de Harness';
      yield { type: 'error', message: 'No pude consultar tus datos. Reintenta.', requestId: detail };
      return;
    }
  }
}

const runWithRetries = async function* (
  owner: string,
  month: string,
  message: string,
  sessionId: string,
  requestId: string,
): AsyncGenerator<SseEvent> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      yield* invokeHarnessStream(owner, month, message, sessionId);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 2) break;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : 'Error desconocido';
  yield {
    type: 'error',
    message: 'No pude consultar tus datos. Reintenta.',
    requestId: `${requestId}:${detail.slice(0, 80)}`,
  };
};

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId || randomUUID();
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'POST' && path.endsWith('/agent/chat')) {
    try {
      const owner = principal(event);
      const body = parseBody(event.body);
      let payload = '';
      for await (const item of runWithRetries(owner, body.month, body.message, body.sessionId, requestId)) {
        payload += sse(item);
        if (item.type === 'error') {
          return {
            statusCode: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              'x-request-id': requestId,
            },
            body: payload,
          };
        }
      }
      payload += sse({ type: 'done', requestId, sessionId: body.sessionId });
      return {
        statusCode: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-request-id': requestId,
        },
        body: payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No pude consultar tus datos.';
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
        body: JSON.stringify({ message, requestId }),
      };
    }
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ message: 'Route not found.' }),
  };
};

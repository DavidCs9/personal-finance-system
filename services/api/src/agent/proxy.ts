import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Writable } from 'node:stream';
import { resolveRuntimePrompt } from './prompt-runtime.js';

const harnessArn = process.env.HARNESS_ARN?.trim();
const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID?.trim();
const cognitoClientId = process.env.COGNITO_CLIENT_ID?.trim();
const agentcore = new BedrockAgentCoreClient({});

const jwtVerifier = cognitoUserPoolId && cognitoClientId
  ? CognitoJwtVerifier.create({
    userPoolId: cognitoUserPoolId,
    tokenUse: 'id',
    clientId: cognitoClientId,
  })
  : undefined;

/** Lambda runtime global for response streaming (not an npm module). */
type LambdaRuntime = {
  readonly streamifyResponse: (
    handler: (
      event: APIGatewayProxyEventV2,
      responseStream: Writable,
      context: Context,
    ) => Promise<void>,
  ) => (event: APIGatewayProxyEventV2, responseStream: Writable, context: Context) => Promise<void>;
  readonly HttpResponseStream: {
    readonly from: (
      stream: Writable,
      metadata: { readonly statusCode: number; readonly headers?: Record<string, string> },
    ) => Writable;
  };
};

const lambdaRuntime = (globalThis as typeof globalThis & { awslambda?: LambdaRuntime }).awslambda;

type SseEvent =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'citation'; readonly kind: string; readonly id?: string; readonly label: string }
  | { readonly type: 'proposal'; readonly eventId: string; readonly categoryId: string; readonly message: string }
  | { readonly type: 'done'; readonly requestId: string; readonly sessionId: string }
  | { readonly type: 'error'; readonly message: string; readonly requestId: string };

const sse = (event: SseEvent): string => `data: ${JSON.stringify(event)}\n\n`;

const headerValue = (
  headers: APIGatewayProxyEventV2['headers'] | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
};

const readBody = (event: APIGatewayProxyEventV2): string | undefined => {
  if (!event.body) return undefined;
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
};

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

const verifyOwner = async (event: APIGatewayProxyEventV2): Promise<string> => {
  if (!jwtVerifier) {
    throw new Error('Cognito JWT verifier is not configured.');
  }
  const authorization = headerValue(event.headers, 'authorization');
  if (!authorization?.toLowerCase().startsWith('bearer ')) {
    throw new Error('Missing authenticated principal.');
  }
  const token = authorization.slice(7).trim();
  const claims = await jwtVerifier.verify(token);
  if (!claims.sub) throw new Error('Missing authenticated principal.');
  return claims.sub;
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

const writeJsonError = (
  responseStream: Writable,
  statusCode: number,
  message: string,
  requestId: string,
): void => {
  if (!lambdaRuntime) throw new Error('awslambda runtime global is required for agent-proxy streaming.');
  const httpStream = lambdaRuntime.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
    },
  });
  httpStream.write(JSON.stringify({ message, requestId }));
  httpStream.end();
};

const streamHandler = async (
  event: APIGatewayProxyEventV2,
  responseStream: Writable,
  _context: Context,
): Promise<void> => {
  if (!lambdaRuntime) {
    throw new Error('awslambda runtime global is required for agent-proxy streaming.');
  }
  const requestId = event.requestContext.requestId || randomUUID();
  const method = event.requestContext.http.method.toUpperCase();

  if (method === 'OPTIONS') {
    const httpStream = lambdaRuntime.HttpResponseStream.from(responseStream, {
      statusCode: 204,
      headers: { 'cache-control': 'no-cache' },
    });
    httpStream.end();
    return;
  }

  if (method !== 'POST') {
    writeJsonError(responseStream, 404, 'Route not found.', requestId);
    return;
  }

  try {
    const owner = await verifyOwner(event);
    const body = parseBody(readBody(event));
    const httpStream = lambdaRuntime.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-request-id': requestId,
      },
    });

    for await (const item of runWithRetries(owner, body.month, body.message, body.sessionId, requestId)) {
      httpStream.write(sse(item));
      if (item.type === 'error') {
        httpStream.end();
        return;
      }
    }
    httpStream.write(sse({ type: 'done', requestId, sessionId: body.sessionId }));
    httpStream.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No pude consultar tus datos.';
    const statusCode = /principal|Bearer|JWT|Unauthorized|token/i.test(message) ? 401 : 400;
    writeJsonError(responseStream, statusCode, message, requestId);
  }
};

export const handler = lambdaRuntime
  ? lambdaRuntime.streamifyResponse(streamHandler)
  : async () => {
    throw new Error('awslambda runtime global is required for agent-proxy streaming.');
  };

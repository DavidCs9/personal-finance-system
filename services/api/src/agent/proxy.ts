import type { Context } from 'aws-lambda';
import { Writable } from 'node:stream';
import {
  formatSse,
  agentChatErrorStatus,
  assertConfiguredAgentOwner,
  type AgentChatGatewayEvent,
  parseChatBody,
  readBody,
  requestIdOf,
  requestMethod,
  resolveOwner,
  runAgentChat,
} from './chat-core.js';
import { prepareAssistantThread } from './thread-runtime.js';

/** Lambda runtime global for response streaming (not an npm module). */
type LambdaRuntime = {
  readonly streamifyResponse: (
    handler: (
      event: AgentChatGatewayEvent,
      responseStream: Writable,
      context: Context,
    ) => Promise<void>,
  ) => (event: AgentChatGatewayEvent, responseStream: Writable, context: Context) => Promise<void>;
  readonly HttpResponseStream: {
    readonly from: (
      stream: Writable,
      metadata: { readonly statusCode: number; readonly headers?: Record<string, string> },
    ) => Writable;
  };
};

const lambdaRuntime = (globalThis as typeof globalThis & { awslambda?: LambdaRuntime }).awslambda;
const webAppOrigin = (process.env.WEB_APP_URL?.trim() || 'https://finance.castrodavid.dev').replace(/\/$/, '');

const corsHeaders = (): Record<string, string> => ({
  'access-control-allow-origin': webAppOrigin,
  'access-control-expose-headers': 'x-request-id',
  vary: 'Origin',
});

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
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': requestId,
    },
  });
  httpStream.write(JSON.stringify({ message, requestId }));
  httpStream.end();
};

const streamHandler = async (
  event: AgentChatGatewayEvent,
  responseStream: Writable,
  _context: Context,
): Promise<void> => {
  if (!lambdaRuntime) {
    throw new Error('awslambda runtime global is required for agent-proxy streaming.');
  }
  const requestId = requestIdOf(event);
  const method = requestMethod(event);

  if (method === 'OPTIONS') {
    const httpStream = lambdaRuntime.HttpResponseStream.from(responseStream, {
      statusCode: 204,
      headers: { ...corsHeaders(), 'cache-control': 'no-cache' },
    });
    httpStream.end();
    return;
  }

  if (method !== 'POST') {
    writeJsonError(responseStream, 404, 'Route not found.', requestId);
    return;
  }

  try {
    const owner = await resolveOwner(event);
    assertConfiguredAgentOwner(owner);
    const body = parseChatBody(readBody(event));
    await prepareAssistantThread(owner, body.sessionId, body.message, body.month);
    const httpStream = lambdaRuntime.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-request-id': requestId,
      },
    });

    for await (const item of runAgentChat(owner, body.month, body.message, body.sessionId, requestId)) {
      httpStream.write(formatSse(item));
      if (item.type === 'error') {
        httpStream.end();
        return;
      }
    }
    httpStream.write(formatSse({ type: 'done', requestId, sessionId: body.sessionId }));
    httpStream.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No pude consultar tus datos.';
    const statusCode = agentChatErrorStatus(error);
    writeJsonError(responseStream, statusCode, message, requestId);
  }
};

export const handler = lambdaRuntime
  ? lambdaRuntime.streamifyResponse(streamHandler)
  : async () => {
    throw new Error('awslambda runtime global is required for agent-proxy streaming.');
  };

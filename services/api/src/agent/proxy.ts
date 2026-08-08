import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Writable } from 'node:stream';
import {
  formatSse,
  parseChatBody,
  readBody,
  resolveOwner,
  runAgentChat,
} from './chat-core.js';

/** Lambda runtime global for response streaming (not an npm module). Deprecated product path. */
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
    const owner = await resolveOwner(event);
    const body = parseChatBody(readBody(event));
    const httpStream = lambdaRuntime.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
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
    const statusCode = /principal|Bearer|JWT|Unauthorized|token/i.test(message) ? 401 : 400;
    writeJsonError(responseStream, statusCode, message, requestId);
  }
};

/** @deprecated Product path is POST /agent/chat (buffered JSON). Kept for rollback only. */
export const handler = lambdaRuntime
  ? lambdaRuntime.streamifyResponse(streamHandler)
  : async () => {
    throw new Error('awslambda runtime global is required for agent-proxy streaming.');
  };

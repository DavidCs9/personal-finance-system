import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  collectAgentChat,
  parseChatBody,
  readBody,
  resolveOwner,
} from './chat-core.js';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId || randomUUID();
  const method = event.requestContext.http.method.toUpperCase();

  if (method !== 'POST') {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
      body: JSON.stringify({ message: 'Route not found.', requestId }),
    };
  }

  try {
    const owner = await resolveOwner(event);
    const body = parseChatBody(readBody(event));
    const events = await collectAgentChat(owner, body.month, body.message, body.sessionId, requestId);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
      body: JSON.stringify({
        requestId,
        sessionId: body.sessionId,
        events,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No pude consultar tus datos.';
    const statusCode = /principal|Bearer|JWT|Unauthorized|token/i.test(message) ? 401 : 400;
    return {
      statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
      body: JSON.stringify({ message, requestId }),
    };
  }
};

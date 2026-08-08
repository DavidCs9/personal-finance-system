import { describe, expect, it } from 'vitest';
import {
  readBody,
  requestIdOf,
  requestMethod,
  resolveOwner,
  summarizeToolResult,
  type AgentChatGatewayEvent,
} from './chat-core.js';

const restApiEvent = (): AgentChatGatewayEvent => ({
  body: Buffer.from('{"message":"hola"}').toString('base64'),
  isBase64Encoded: true,
  headers: {},
  httpMethod: 'POST',
  requestContext: {
    requestId: 'rest-request-1',
    authorizer: { claims: { sub: 'cognito-owner-sub' } },
  },
});

describe('REST API Gateway chat event helpers', () => {
  it('uses the REST Cognito authorizer subject without re-verifying the bearer token', async () => {
    await expect(resolveOwner(restApiEvent())).resolves.toBe('cognito-owner-sub');
  });

  it('reads REST API request metadata and body', () => {
    const event = restApiEvent();
    expect(requestMethod(event)).toBe('POST');
    expect(requestIdOf(event)).toBe('rest-request-1');
    expect(readBody(event)).toBe('{"message":"hola"}');
  });

  it('creates audit summaries without exposing raw tool rows', () => {
    expect(summarizeToolResult('list_movements', {
      movements: [{ merchantRaw: 'Mercado' }, { merchantRaw: 'Farmacia' }],
    })).toEqual({ summary: 'Revisé 2 movimientos.', material: true });
    expect(summarizeToolResult('propose_recategorize', {
      eventId: 'private-event-id',
      categoryId: 'food',
    })).toEqual({ summary: 'Propuesta de categoría preparada.', material: false });
  });
});

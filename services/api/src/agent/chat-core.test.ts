import { describe, expect, it } from 'vitest';
import {
  readBody,
  requestIdOf,
  requestMethod,
  resolveOwner,
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
});

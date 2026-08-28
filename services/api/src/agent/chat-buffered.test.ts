import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.mock('./chat-core.js', () => ({
  agentChatErrorStatus: vi.fn((error: unknown) =>
    error instanceof Error && /principal/i.test(error.message) ? 401 : 400),
  assertConfiguredAgentOwner: vi.fn(),
  resolveOwner: vi.fn(async () => 'owner-sub'),
  parseChatBody: vi.fn(() => ({
    message: 'hola',
    month: '2026-08',
    sessionId: '11111111-1111-1111-1111-111111111111',
  })),
  readBody: vi.fn(() => '{"message":"hola","month":"2026-08"}'),
  collectAgentChat: vi.fn(async () => [
    { type: 'token', text: 'Hola' },
    { type: 'done', requestId: 'req-1', sessionId: '11111111-1111-1111-1111-111111111111' },
  ]),
}));

vi.mock('./thread-runtime.js', () => ({
  prepareAssistantThread: vi.fn(async () => ({ id: '11111111-1111-1111-1111-111111111111' })),
}));

import { assertConfiguredAgentOwner, collectAgentChat, resolveOwner } from './chat-core.js';
import { prepareAssistantThread } from './thread-runtime.js';
import { handler } from './chat-buffered.js';

const baseEvent = (): APIGatewayProxyEventV2 => ({
  version: '2.0',
  routeKey: 'POST /agent/chat',
  rawPath: '/agent/chat',
  rawQueryString: '',
  headers: {},
  requestContext: {
    accountId: '1',
    apiId: 'api',
    domainName: 'example.execute-api.us-east-2.amazonaws.com',
    domainPrefix: 'example',
    http: {
      method: 'POST',
      path: '/agent/chat',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'vitest',
    },
    requestId: 'req-1',
    routeKey: 'POST /agent/chat',
    stage: '$default',
    time: '01/Jan/2026:00:00:00 +0000',
    timeEpoch: 0,
  },
  isBase64Encoded: false,
});

describe('agent chat buffered handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns buffered JSON events', async () => {
    const result = await handler(baseEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    if (typeof result === 'string' || !result || !('body' in result)) {
      throw new Error('expected proxy result');
    }
    const body = JSON.parse(result.body ?? '{}') as {
      sessionId: string;
      events: { type: string; text?: string }[];
    };
    expect(body.sessionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.events).toEqual([
      { type: 'token', text: 'Hola' },
      { type: 'done', requestId: 'req-1', sessionId: '11111111-1111-1111-1111-111111111111' },
    ]);
    expect(collectAgentChat).toHaveBeenCalledOnce();
    expect(resolveOwner).toHaveBeenCalledOnce();
    expect(assertConfiguredAgentOwner).toHaveBeenCalledWith('owner-sub');
    expect(prepareAssistantThread).toHaveBeenCalledWith(
      'owner-sub',
      '11111111-1111-1111-1111-111111111111',
      'hola',
      '2026-08',
    );
  });

  it('rejects non-POST', async () => {
    const event = baseEvent();
    event.requestContext.http.method = 'GET';
    const result = await handler(event);
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('maps auth failures to 401', async () => {
    vi.mocked(resolveOwner).mockRejectedValueOnce(new Error('Missing authenticated principal.'));
    const result = await handler(baseEvent());
    expect(result).toMatchObject({ statusCode: 401 });
  });
});

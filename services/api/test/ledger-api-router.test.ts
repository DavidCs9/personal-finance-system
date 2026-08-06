import { describe, expect, it } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';

const { handler } = await import('../src/http/ledger-api.js');

const context = {
  awsRequestId: 'req-1',
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'api',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-east-2:1:function:api',
  memoryLimitInMB: '128',
  logGroupName: '/aws/lambda/api',
  logStreamName: 'stream',
  getRemainingTimeInMillis: () => 1_000,
  done() {},
  fail() {},
  succeed() {},
};

const httpEvent = (method: string, path: string, query: Record<string, string> = {}) => ({
  version: '2.0' as const,
  routeKey: `${method} ${path}`,
  rawPath: path,
  rawQueryString: new URLSearchParams(query).toString(),
  headers: {},
  queryStringParameters: Object.keys(query).length ? query : undefined,
  requestContext: {
    accountId: '1',
    apiId: 'api',
    domainName: 'example.com',
    domainPrefix: 'example',
    http: {
      method,
      path,
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'vitest',
    },
    requestId: 'req-1',
    routeKey: `${method} ${path}`,
    stage: '$default',
    time: 'now',
    timeEpoch: Date.now(),
    authorizer: { jwt: { claims: { sub: 'owner-1' }, scopes: [] } },
  },
  isBase64Encoded: false,
});

describe('ledger API Powertools router', () => {
  it('returns 404 for unknown routes', async () => {
    const result = await handler(httpEvent('GET', '/unknown'), context);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(String(result.body))).toEqual({ message: 'Route not found.' });
  });

  it('returns 400 when GET /events is missing month', async () => {
    const result = await handler(httpEvent('GET', '/events'), context);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(String(result.body))).toEqual({
      message: 'Query parameter month (YYYY-MM) is required.',
    });
  });

  it('returns 400 for invalid month path', async () => {
    const result = await handler(httpEvent('GET', '/months/2026-13'), context);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(String(result.body))).toEqual({
      message: 'Month must use YYYY-MM format.',
    });
  });

  it('returns 400 when posting a snapshot to a non-Cajita account', async () => {
    const result = await handler(
      {
        ...httpEvent('POST', '/wealth/accounts/bitso/snapshots'),
        body: JSON.stringify({ amountMinor: 100 }),
      },
      context,
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(String(result.body)).message).toMatch(/nu_cajita_emergencia/);
  });
});

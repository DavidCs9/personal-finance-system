import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.METADATA_TABLE_NAME ??= 'test-metadata-table';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-bucket';

const { handler } = await import('../src/http/ledger-api.js');
const statements = await import('../src/imports/statement-catalog.js');
const uploads = await import('../src/imports/statement-upload.js');
const reconciliations = await import('../src/months/reconciliation.js');
afterEach(() => vi.restoreAllMocks());

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
  it('binds explicit fixed payment reconciliation to the authenticated owner and returns its refreshed plan', async () => {
    const saved = { month: '2026-10', upcomingPayments: [] };
    const write = vi.spyOn(reconciliations, 'savePaymentReconciliation').mockResolvedValue(saved);
    const input = { eventId: 'c0000000-0000-4000-8000-000000000001', expectedEventId: null,
      expectedPayment:{name:'OpenAI',amountMinor:39900,dueDay:18} };
    const result = await handler({ ...httpEvent('PUT', '/months/2026-10/payments/openai/reconciliation', { owner: 'forged' }),
      body: JSON.stringify({ ...input, owner: 'forged' }) }, context);
    expect(result.statusCode).toBe(200);
    expect(write).toHaveBeenCalledWith('owner-1', '2026-10', 'openai', input);
    expect(JSON.parse(String(result.body))).toEqual(saved);
  });

  it('rejects malformed reconciliation bodies and reports concurrent changes as conflicts', async () => {
    const write = vi.spyOn(reconciliations, 'savePaymentReconciliation');
    const malformed = await handler({ ...httpEvent('PUT', '/months/2026-10/payments/openai/reconciliation'), body: '{}' }, context);
    expect(malformed.statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
    write.mockRejectedValue(new reconciliations.PaymentReconciliationConflictError('El vínculo cambió.'));
    const conflict = await handler({ ...httpEvent('PUT', '/months/2026-10/payments/openai/reconciliation'),
      body: JSON.stringify({ eventId: null, expectedEventId: 'c0000000-0000-4000-8000-000000000001',
        expectedPayment:{name:'OpenAI',amountMinor:39900,dueDay:18} }) }, context);
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(String(conflict.body)).message).toBe('El vínculo cambió.');
  });

  it('scopes the statement catalog and original PDF routes to the authenticated principal', async () => {
    const catalog = { asOfDay: '2026-10-24', accounts: [], unidentifiedDocuments: [] };
    const read = vi.spyOn(statements, 'getStatementCatalog').mockResolvedValue(catalog);
    const result = await handler(httpEvent('GET', '/statements', { owner: 'forged' }), context);
    expect(result.statusCode).toBe(200);
    expect(result.headers).toMatchObject({ 'cache-control': 'no-store' });
    expect(JSON.parse(String(result.body))).toEqual(catalog);
    expect(read).toHaveBeenCalledWith('owner-1');
    const source = vi.spyOn(statements, 'getStatementSource').mockResolvedValue(undefined);
    expect((await handler(httpEvent('GET', `/statements/amex/${'a'.repeat(64)}/source`), context)).statusCode).toBe(404);
    expect(source).toHaveBeenCalledWith('amex', 'a'.repeat(64), 'owner-1');
  });
  for (const provider of ['amex', 'santander-statement']) {
    it(`${provider} signs an upload for the authenticated principal`, async () => {
      const create = vi.spyOn(uploads, 'createStatementUpload').mockResolvedValue({ url: 'https://s3.test/upload', headers: {} });
      const body = JSON.stringify({ sha256: 'a'.repeat(64), size: 5_584_168 });
      const result = await handler({ ...httpEvent('POST', `/imports/${provider}/upload`), body }, context);
      expect(result.statusCode).toBe(200);
      expect(create).toHaveBeenCalledWith(provider === 'amex' ? 'amex' : 'santander', 'owner-1', body);
    });
    it(`${provider} refuses PDF bodies through the preview route`, async () => {
      const result = await handler({ ...httpEvent('POST', `/imports/${provider}/preview`), body: '%PDF-', headers: { 'content-type': 'application/pdf' } }, context);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(String(result.body)).message).toContain('directamente');
    });
  }
  it('rejects invalid commitment periods through the public route', async () => {
    const result = await handler(httpEvent('GET', '/commitments', {startMonth:'2026-13'}), context);
    expect(result.statusCode).toBe(400);
  });
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

  it('returns 400 when GET /analytics is missing its month', async () => {
    const result = await handler(httpEvent('GET', '/analytics'), context);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(String(result.body))).toEqual({
      message: 'Query parameter month (YYYY-MM) is required.',
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

  it('does not expose the internal agent bulk-edit service as a public route', async () => {
    const result = await handler(
      {
        ...httpEvent('POST', '/bulk-edits/preview'),
        body: JSON.stringify({
          selection: { fromDay: '2026-08-25', toDay: '2026-08-21' },
          change: { addTags: ['viaje:vegas'] },
        }),
      },
      context,
    );
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(String(result.body))).toEqual({ message: 'Route not found.' });
  });
});

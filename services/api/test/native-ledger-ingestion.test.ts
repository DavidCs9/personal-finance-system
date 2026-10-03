import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../../ledger/src/dsql/ledger-schema.js';
import { readLedgerDetail } from '../../ledger/src/dsql/ledger-reads.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool,
  s3: vi.fn(), secret: vi.fn(), push: vi.fn() }));
// External source/auth/push services are mocked; all financial reads and writes execute real SQL.
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class { send = harness.s3; }, GetObjectCommand: class {} }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({ SecretsManagerClient: class { send = harness.secret; }, GetSecretValueCommand: class {} }));
vi.mock('@finance/notify', () => ({ notifyObservedPurchasePush: harness.push }));

let sql: PGlite;
let apple: typeof import('../src/apple-pay/apple-pay-capture.js');
let email: typeof import('../../ingestion/src/process-email.js');
let retryOnce = false;
let transactionCalls = 0;
const at = '2026-10-02T12:00:00.123Z';
const auth = 'capture-token-with-more-than-thirty-two-characters';
const mime = (amount = '1,000.00', merchant = 'Original shop', id = 'original@example.com') =>
  `From: alertas@santander.com.mx\nMessage-ID: <${id}>\nSubject: Compra\n\nSantander\nCompra por $${amount} MXN\nEn: ${merchant}\nTarjeta **** 1234\nFecha: 2026-10-02T12:00:00Z`;
const emailToken = (raw: string, id = 'original@example.com') =>
  createHash('sha256').update(`${id}:${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
const capture = async (requestId = 'original-request', currency = 'MXN', amountRaw = '$1,000.00', bearer = auth) => {
  const event: Parameters<typeof apple.handler>[0] = {
    version: '2.0', routeKey: 'POST /capture', rawPath: '/capture', rawQueryString: '', isBase64Encoded: false,
    requestContext: { accountId: 'account', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/capture', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'request', routeKey: 'POST /capture', stage: '$default', time: at, timeEpoch: Date.parse(at) },
    headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': requestId },
    body: JSON.stringify({ requestId, institution: 'santander_mx', occurredAt: at, currency,
      amountRaw, merchantRaw: 'Original shop', cardRaw: 'Original card', nameRaw: 'Original name' }) };
  const result = await apple.handler(event, {} as never, () => {});
  if (!result || typeof result === 'string' || !('body' in result)) throw new Error('Missing capture response');
  return { status: result.statusCode, body: JSON.parse(result.body ?? '{}') as Record<string, unknown> };
};
const ingest = async (raw: string, retryExceptionId?: string) => {
  harness.s3.mockResolvedValue({ Body: { transformToString: async () => raw } });
  const event = { Records: [{ messageId: 'queue-delivery', body: JSON.stringify({ receivedAt: at,
    source: { bucket: 'evidence', key: 'original.eml' }, retryExceptionId }) }] };
  return email.ingestionHandler(event as Parameters<typeof email.ingestionHandler>[0], {} as never, () => {});
};
const snapshot = async () => Object.fromEntries(await Promise.all(NATIVE_LEDGER_TABLES.map(async table =>
  [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2`)).rows])));
beforeAll(async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true');
  vi.stubEnv('METADATA_TABLE_NAME', 'metadata');
  vi.stubEnv('APPLE_PAY_CAPTURE_SECRET_ARN', 'capture-secret');
  vi.stubEnv('VAPID_SECRET_ARN', 'vapid'); vi.stubEnv('WEB_APP_URL', 'https://olbia.example.com');
  sql = new PGlite();
  for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_LEDGER_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP),(19,CURRENT_TIMESTAMP)');
  harness.pool = { query: (s, v) => sql.query<Record<string, unknown>>(s, v), transaction: async fn => {
    transactionCalls++;
    if (retryOnce) {
      retryOnce = false;
      const interruption = new Error('Simulated connector transaction retry');
      await expect(sql.transaction(async client => {
        await fn(client as unknown as SqlClient);
        expect((await client.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
        expect(harness.push).not.toHaveBeenCalled();
        throw interruption;
      })).rejects.toBe(interruption);
    }
    return sql.transaction(client => fn(client as unknown as SqlClient));
  } };
  apple = await import('../src/apple-pay/apple-pay-capture.js');
  email = await import('../../ingestion/src/process-email.js');
}, 30_000);
afterAll(async () => { await sql.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts', 'projection_state', 'command_receipts', 'ingestion_exceptions'].map(t => `olbia.${t}`).join(',')}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.clearAllMocks(); retryOnce = false; transactionCalls = 0;
  harness.secret.mockResolvedValue({ SecretString: JSON.stringify({ token: auth }) });
  harness.push.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
});

describe('actual Apple Pay and email handlers on native SQL', () => {
  it('keeps authentication and validation ahead of financial writes', async () => {
    expect((await capture('valid-request', 'MXN', '$1,000.00', 'invalid')).status).toBe(401);
    expect((await capture('short')).status).toBe(400);
    expect(transactionCalls).toBe(0); expect(harness.push).not.toHaveBeenCalled();
  });

  it('creates one native Apple Pay capture and sends a push once across transaction retry and duplicate delivery', async () => {
    retryOnce = true;
    const first = await capture(); expect(first.status).toBe(201);
    const second = await capture(); expect(second).toMatchObject({ status: 200,
      body: { eventId: first.body.eventId, observationId: first.body.observationId, duplicate: true } });
    expect(harness.push).toHaveBeenCalledTimes(1);
    expect((await sql.query('SELECT token FROM olbia.source_claims')).rows).toEqual([{ token: 'original-request' }]);
    expect((await sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
    expect(await readLedgerDetail(harness.pool, String(first.body.eventId))).toMatchObject({
      source: { kind: 'apple_pay_shortcut', requestId: 'original-request', cardRaw: 'Original card', nameRaw: 'Original name' },
      observationCount: 1, captureSources: ['apple_pay_shortcut'] });
  });

  it('promotes a USD authorization through the real email parser, retaining both original observations and suppressing duplicate pushes', async () => {
    const first = await capture('foreign-request', 'USD', 'US$50.00');
    expect(first.status).toBe(201);
    expect(await ingest(mime())).toEqual({ batchItemFailures: [] });
    const detail = await readLedgerDetail(harness.pool, String(first.body.eventId));
    expect(detail).toMatchObject({ status: 'accepted', amount: { amountMinor: 100000, currency: 'MXN' },
      captureSources: ['apple_pay_shortcut', 'email'], observationCount: 2,
      source: { requestId: 'foreign-request', currency: 'USD' } });
    expect((detail!.observations as Record<string, unknown>[]).map(item => item.amount)).toEqual(expect.arrayContaining([
      { amountMinor: 100000, currency: 'MXN' }, { amountMinor: 5000, currency: 'USD' },
    ]));
    const before = await snapshot();
    expect(await ingest(mime())).toEqual({ batchItemFailures: [] });
    expect(await snapshot()).toEqual(before); expect(harness.push).toHaveBeenCalledTimes(1);
    expect((await sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
  });

  it('creates a parsed email once and reads its source once even when the SQL callback retries', async () => {
    retryOnce = true;
    expect(await ingest(mime())).toEqual({ batchItemFailures: [] });
    expect(harness.s3).toHaveBeenCalledTimes(1); expect(harness.push).toHaveBeenCalledTimes(1);
    const before = await snapshot();
    expect(await ingest(mime())).toEqual({ batchItemFailures: [] });
    expect(await snapshot()).toEqual(before); expect(harness.push).toHaveBeenCalledTimes(1);
    expect((await sql.query('SELECT capture_source,token FROM olbia.source_claims')).rows)
      .toEqual([{ capture_source: 'email', token: emailToken(mime()) }]);
  });

  it('preserves prior unresolved suppression and records new administrative suppression without creating movements', async () => {
    await sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome)
      VALUES ('email',$1,$2,'unresolved_suppression')`, [emailToken(mime()), at]);
    const before = await snapshot();
    expect(await ingest(mime())).toEqual({ batchItemFailures: [] });
    expect(await snapshot()).toEqual(before); expect(harness.push).not.toHaveBeenCalled();
    const administrative = 'From: forwarding-noreply@google.com\nSubject: Gmail Forwarding Confirmation\nMessage-ID: <admin@example.com>\n\nAdministrative';
    expect(await ingest(administrative)).toEqual({ batchItemFailures: [] });
    expect(await ingest(administrative)).toEqual({ batchItemFailures: [] });
    expect((await sql.query('SELECT outcome FROM olbia.source_claims ORDER BY outcome')).rows)
      .toEqual([{ outcome: 'suppressed' }, { outcome: 'unresolved_suppression' }]);
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([]);
    expect((await sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
  });

  it('fails a financial delivery while paused and succeeds on the same source after resuming', async () => {
    await sql.query("UPDATE olbia.runtime_state SET mode='paused' WHERE id='storage'");
    expect(await ingest(mime())).toEqual({ batchItemFailures: [{ itemIdentifier: 'queue-delivery' }] });
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([]);
    expect(harness.push).not.toHaveBeenCalled();
    await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
    expect(await ingest(mime())).toEqual({ batchItemFailures: [] });
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
  });
});

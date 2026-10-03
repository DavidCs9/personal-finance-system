import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../../ledger/src/dsql/ledger-schema.js';
import { saveNativeCapture } from '../../ledger/src/dsql/ledger-capture.js';
import { runSqlTransaction } from '../../ledger/src/dsql/sql-runtime.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool, s3: vi.fn() }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
vi.mock('@aws-sdk/client-s3', async importOriginal => ({
  ...await importOriginal<typeof import('@aws-sdk/client-s3')>(), S3Client: class { send = harness.s3; },
}));
let sql: PGlite;
let manual: typeof import('../src/events/manual-entry.js');
let retryOnce = false;
let failClaim = false;
const at = '2026-10-02T12:00:00.000Z';
const input = { institution: 'santander_mx', merchantRaw: 'Original shop', amountMinor: 10000,
  occurredOn: '2026-10-02', accountLastFour: '1234', note: 'Original note' };
const create = (changes: Record<string, unknown> = {}) => manual.createManualEvent(JSON.stringify({ ...input, ...changes }), 'owner');
const snapshot = async () => Object.fromEntries(await Promise.all(NATIVE_LEDGER_TABLES.map(async table =>
  [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2`)).rows])));
beforeAll(async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true'); vi.stubEnv('METADATA_TABLE_NAME', 'metadata');
  vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence');
  sql = new PGlite();
  for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_LEDGER_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  harness.pool = { query: (s, v) => sql.query<Record<string, unknown>>(s, v), transaction: async fn => {
    const invoke = (client: SqlClient) => fn({ query: (statement, values) => {
      if (failClaim && statement.startsWith('INSERT INTO olbia.source_claims')) throw new Error('Interrupted manual claim');
      return client.query(statement, values);
    } });
    if (retryOnce) {
      retryOnce = false;
      const interruption = new Error('Simulated connector transaction retry');
      await expect(sql.transaction(async client => {
        await invoke(client as unknown as SqlClient);
        expect((await client.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
        expect(harness.s3).toHaveBeenCalledTimes(1);
        throw interruption;
      })).rejects.toBe(interruption);
    }
    return sql.transaction(client => invoke(client as unknown as SqlClient));
  } };
  manual = await import('../src/events/manual-entry.js');
}, 30_000);
afterAll(async () => { await sql.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts', 'projection_state', 'command_receipts'].map(t => `olbia.${t}`).join(',')}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  vi.clearAllMocks(); harness.s3.mockResolvedValue({}); retryOnce = false; failClaim = false;
});

describe('manual capture with native financial authority', () => {
  it('preserves original note/account/evidence and returns the same native record when a replay changes the note', async () => {
    const first = await create();
    expect(first).toMatchObject({ captureSources: ['manual'], observationCount: 1, hasRawEmail: false,
      accountName: 'Santander terminada en 1234', amount: { amountMinor: 10000, currency: 'MXN' },
      observations: [{ note: 'Original note', account: { lastFour: '1234' } }] });
    const before = await snapshot();
    expect(await create({ note: 'Changed note', merchantRaw: ' ORIGINAL SHOP ' })).toEqual(first);
    expect(await snapshot()).toEqual(before); expect(harness.s3).toHaveBeenCalledTimes(1);
    const command = harness.s3.mock.calls[0][0] as { input: { Body: string; Key: string; IfNoneMatch: string } };
    const sha = createHash('sha256').update(command.input.Body).digest('hex');
    expect(command.input).toMatchObject({ IfNoneMatch: '*', Key: `manual-entries/owner/${sha}.json` });
    expect(first.source).toMatchObject({ sha256: sha, key: command.input.Key });
    expect((await sql.query('SELECT source_pk FROM olbia.projection_state')).rows).toEqual([]);
  });

  it('creates a distinct purchase when David explicitly enters an existing email purchase', async () => {
    const existing = await runSqlTransaction(harness.pool, client => saveNativeCapture(client, {
      captureSource: 'email', token: 'original-email', reconciliationAt: at,
      event: { id: '11111111-1111-4111-8111-111111111111', institution: input.institution,
        eventType: 'card_purchase', status: 'accepted', amount: { amountMinor: input.amountMinor, currency: 'MXN' },
        merchantRaw: input.merchantRaw, occurredAt: at, receivedAt: at, ingestedAt: at,
        source: { bucket: 'evidence', key: 'original.eml', sha256: 'a'.repeat(64), contentType: 'message/rfc822' },
        parserVersion: 'original', parseWarnings: [] },
    }));
    const created = await create(); expect(created.id).not.toBe(existing.eventId);
    expect(created).toMatchObject({ captureSources: ['manual'], observationCount: 1 });
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(2);
  });

  it('uses a second transactional claim check so simultaneous first requests share one purchase', async () => {
    const [first, second] = await Promise.all([create(), create()]);
    expect(second).toEqual(first);
    expect((await sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(1);
    expect((await sql.query('SELECT id FROM olbia.ledger_observations')).rows).toHaveLength(1);
    expect((await sql.query('SELECT token FROM olbia.source_claims')).rows).toHaveLength(1);
  });

  it('keeps evidence upload outside SQL retries and builds the automatic Amex plan from typed rows', async () => {
    retryOnce = true;
    const created = await create({ institution: 'american_express_mx', amountMinor: 300000, accountLastFour: undefined });
    expect(created).toMatchObject({ accountName: 'American Express (registro manual)',
      msi: { months: 3, principalMinor: 300000, origin: 'amex_auto', installments: [
        { index: 1, month: '2026-10', amountMinor: 100000, status: 'committed' },
        { index: 2, month: '2026-11', amountMinor: 100000, status: 'committed' },
        { index: 3, month: '2026-12', amountMinor: 100000, status: 'committed' },
      ] } });
    expect(harness.s3).toHaveBeenCalledTimes(1);
    expect((await sql.query('SELECT id FROM olbia.ledger_observations')).rows).toHaveLength(1);
  });

  it('does not create financial rows after failed evidence or an interrupted financial claim, and retries cleanly', async () => {
    const before = await snapshot(); harness.s3.mockRejectedValueOnce(new Error('Evidence unavailable'));
    await expect(create()).rejects.toThrow('Evidence unavailable'); expect(await snapshot()).toEqual(before);
    failClaim = true; await expect(create()).rejects.toThrow('Interrupted manual claim');
    expect(await snapshot()).toEqual(before);
    failClaim = false; expect(await create()).toMatchObject({ observationCount: 1 });
    expect((await sql.query('SELECT token FROM olbia.command_receipts')).rows).toEqual([]);
  });
});

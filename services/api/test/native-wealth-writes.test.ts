import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../../ledger/src/dsql/connection.js';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS, NATIVE_WEALTH_TABLES } from '../../ledger/src/dsql/wealth-schema.js';
import { migrateWealth } from '../../ledger/src/dsql/wealth-copy.js';
import { runNativeTransaction } from '../../ledger/src/dsql/store.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import { readNativeWealthInputs, readNativeWealthAudit } from '../src/wealth/native-reads.js';

process.env.METADATA_TABLE_NAME ??= 'test';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-evidence';
const { createCajitaSnapshot, createCardLiabilitySnapshot, persistWealthSnapshot } = await import('../src/wealth/service.js');

let sql: PGlite;
let retryNext = false;
let interruptHolding = false;
const attemptIds: unknown[] = [];
const now = '2026-10-01T05:59:59.123Z'; // September 30 in Chihuahua.
const holding = (value = -100) => ({ id: 'cash', symbol: 'USD', name: 'Cash', quantity: -0.12345678912345678,
  currency: 'USD', valueNativeMinor: value, valueMxnMinor: value });
const providerCapture = (value = -100) => persistWealthSnapshot({ owner: 'owner', accountId: 'ibkr', source: 'flex',
  holdings: [holding(value)], evidenceKind: 'api', evidenceBody: JSON.stringify({ holding: holding(value) }), fxRate: 17.123456789123456 });
const pool: TransactionPool = { transaction: async callback => {
  const attempt = () => sql.transaction(async client => {
    const wrapped: SqlClient = { query: async (statement, values) => {
      if (statement.startsWith('INSERT INTO olbia.asset_captures')) attemptIds.push(values?.[0]);
      if (interruptHolding && statement.startsWith('INSERT INTO olbia.asset_holdings')) throw new Error('Interrupted holding insertion');
      return client.query<Record<string, unknown>>(statement, values);
    } };
    const result = await callback(wrapped);
    if (retryNext) { retryNext = false; throw new Error('Simulated connector OCC retry'); }
    return result;
  });
  try { return await attempt(); }
  catch (error) { if ((error as Error).message !== 'Simulated connector OCC retry') throw error; return attempt(); }
} };

beforeAll(async () => {
  sql = new PGlite();
  for (const statement of [...SCHEMA_STATEMENTS, ...NATIVE_WEALTH_SCHEMA_STATEMENTS]) await sql.query(statement);
  await sql.query("INSERT INTO olbia.card_profiles VALUES ('amex','owner','Amex',25,15,'american_express_mx',$1,$1,NULL)", [now]);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  vi.spyOn(connection, 'createPool').mockReturnValue({ query: sql.query.bind(sql), ...pool } as never);
}, 30_000);
afterAll(() => sql.close());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${NATIVE_WEALTH_TABLES.map(t => `olbia.${t}`).join(',')}`);
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=15');
  await sql.query('UPDATE olbia.card_profiles SET deleted_at=NULL');
  await migrateWealth(pool);
  retryNext = false; interruptHolding = false; attemptIds.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(new Error('Unexpected document mutation'));
  vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
});

describe('native Patrimonio mutations', () => {
  it('writes actual manual/provider paths once per capture, preserving equal-time replacement history, signed precision and paid zero', async () => {
    const first = await providerCapture(-100);
    const second = await providerCapture(200);
    expect(first).toMatchObject({ day: '2026-09-30', totalMxnMinor: -100, holdings: [holding(-100)] });
    expect(second).toMatchObject({ day: '2026-09-30', totalMxnMinor: 200, fxRate: 17.123456789123456 });
    await createCajitaSnapshot('{"amountMinor":1000}', 'owner');
    await createCardLiabilitySnapshot('amex', '{"amountMinor":500}', 'owner');
    await createCardLiabilitySnapshot('amex', '{"amountMinor":0}', 'owner');
    const inputs = await readNativeWealthInputs('owner', sql), audit = await readNativeWealthAudit('owner', sql);
    expect(inputs.snapshots).toHaveLength(2); expect(inputs.liabilitySnapshots[0]?.totalMxnMinor).toBe(0);
    expect(audit).toHaveLength(2);
    expect(audit.find(r => r.kind === 'asset')).toMatchObject({ snapshot: first, replacedAt: now });
    expect(new Set((await sql.query<{ id: string }>('SELECT id FROM olbia.asset_captures')).rows.map(r => r.id)).size).toBe(3);
    expect(DynamoDBDocumentClient.prototype.send).not.toHaveBeenCalled();
    expect(vi.mocked(S3Client.prototype.send).mock.calls.every(([command]) => (command.input as { IfNoneMatch?: string }).IfNoneMatch === '*')).toBe(true);
    for (const table of ['wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions'])
      expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);
  });
  it('preserves last committed daily selection for a late capture and accepts an empty provider capture', async () => {
    vi.setSystemTime(new Date('2026-09-30T13:00:00Z')); const first = await providerCapture(100);
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z')); const second = await providerCapture(200);
    expect((await readNativeWealthInputs('owner', sql)).snapshots).toEqual([second]);
    expect(await readNativeWealthAudit('owner', sql)).toMatchObject([{ snapshot: first, replacedAt: second.capturedAt }]);
    const empty = await persistWealthSnapshot({ owner: 'owner', accountId: 'bitso', source: 'api', holdings: [], evidenceKind: 'api', evidenceBody: '{"balances":[]}' });
    expect(empty).toMatchObject({ totalMxnMinor: 0, holdings: [] });
  });
  it('reuses capture identity and uploads evidence once across an actual rolled-back connector attempt', async () => {
    retryNext = true;
    await providerCapture();
    expect(attemptIds).toHaveLength(2); expect(attemptIds[0]).toBe(attemptIds[1]);
    expect((await sql.query('SELECT * FROM olbia.asset_captures')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.asset_holdings')).rows).toHaveLength(1);
    expect(S3Client.prototype.send).toHaveBeenCalledTimes(1);
  });
  it('rolls back the entire replacement on an interrupted holding insert and an explicit enclosing transaction abort', async () => {
    const first = await providerCapture();
    const before = (await sql.query('SELECT * FROM olbia.asset_captures')).rows;
    interruptHolding = true;
    await expect(providerCapture(200)).rejects.toThrow('Interrupted holding insertion'); interruptHolding = false;
    expect((await sql.query('SELECT * FROM olbia.asset_captures')).rows).toEqual(before);
    expect((await readNativeWealthInputs('owner', sql)).snapshots).toEqual([first]);
    expect(await readNativeWealthAudit('owner', sql)).toEqual([]);
    await expect(runNativeTransaction(pool, async () => { await providerCapture(200); throw new Error('Rollback enclosing capture'); })).rejects.toThrow('Rollback enclosing capture');
    expect((await readNativeWealthInputs('owner', sql)).snapshots).toEqual([first]);
  });
  it('rejects invalid values before IO, refuses inactive/foreign cards, and retains SQL facts on failed evidence upload', async () => {
    await expect(persistWealthSnapshot({ owner: 'owner', accountId: 'ibkr', source: 'flex', holdings: [holding(), holding()], evidenceKind: 'api', evidenceBody: '{}' })).rejects.toThrow('Invalid wealth holding');
    await expect(persistWealthSnapshot({ owner: 'owner', accountId: 'ibkr', source: 'flex', holdings: [{ ...holding(), quantity: NaN }], evidenceKind: 'api', evidenceBody: '{}' })).rejects.toThrow('Invalid wealth holding');
    await expect(persistWealthSnapshot({ owner: 'owner', accountId: 'fondo_ahorro', source: 'derived', holdings: [], evidenceKind: 'api', evidenceBody: '{}' })).rejects.toThrow('cannot be snapshotted');
    await expect(persistWealthSnapshot({ owner: 'owner', accountId: 'ibkr', source: 'flex', holdings: [holding(Number.MAX_SAFE_INTEGER), { ...holding(1), id: 'second' }], evidenceKind: 'api', evidenceBody: '{}' })).rejects.toThrow('safe integer money');
    expect(S3Client.prototype.send).not.toHaveBeenCalled();
    await expect(createCardLiabilitySnapshot('amex', '{"amountMinor":0}', 'unrelated')).rejects.toThrow('Card not found');
    await sql.query("UPDATE olbia.card_profiles SET deleted_at=CURRENT_TIMESTAMP");
    await expect(createCardLiabilitySnapshot('amex', '{"amountMinor":0}', 'owner')).rejects.toThrow('Card not found');
    expect((await sql.query('SELECT * FROM olbia.liability_captures')).rows).toEqual([]);
    vi.mocked(S3Client.prototype.send).mockRejectedValueOnce(new Error('Evidence unavailable'));
    await expect(providerCapture()).rejects.toThrow('Evidence unavailable');
    expect((await sql.query('SELECT * FROM olbia.asset_captures')).rows).toEqual([]);
    vi.mocked(S3Client.prototype.send).mockRejectedValueOnce(Object.assign(new Error('Object already exists'), { name: 'PreconditionFailed' }));
    expect(await providerCapture()).toMatchObject({ totalMxnMinor: -100 });
  });
});

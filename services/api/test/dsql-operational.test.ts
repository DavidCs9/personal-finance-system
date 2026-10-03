import { PGlite } from '@electric-sql/pglite';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../ledger/src/dsql/schema.js';
import { TABLE_NAMES, type SourceItem } from '../../ledger/src/dsql/model.js';
import type { ReadSqlClient } from '../src/events/sql-reads.js';
import { reconcileKey, type SqlClient, type TransactionPool } from '../../ledger/src/dsql/projection.js';
process.env.METADATA_TABLE_NAME ??= 'test'; process.env.RAW_EMAIL_BUCKET_NAME ??= 'test';
const readers = await import('../src/events/sql-reads.js');
const reads = await import('../src/operational/reads.js');
const verify = await import('../src/operational/verification.js');
const exceptions = await import('../src/exceptions/service.js');
let sql: PGlite, pool: TransactionPool, records: SourceItem[], calls: unknown[];
const now = new Date('2026-10-01T12:00:00.000Z');
const exception = (n: number, patch = {}): SourceItem => ({ PK: `EXCEPTION#${n}`, SK: 'EXCEPTION', GSI1PK: 'EXCEPTIONS', GSI1SK: new Date(now.getTime() - n * 1000).toISOString(),
  entityType: 'ingestion_exception', payload: { id: String(n), receivedAt: now.toISOString(), reason: 'parser', details: 'original', ...patch } });
const sub = (): SourceItem => ({ PK: 'USER#owner', SK: 'ASSISTANT_THREAD#session_'+'a'.repeat(33), entityType: 'assistant_thread', owner:'owner',sessionId:'session_'+'a'.repeat(33),title:'Original title',firstMonth:'2026-10',createdAt:now.toISOString(),updatedAt:now.toISOString() });
beforeAll(async () => { sql = new PGlite(); for (const ddl of SCHEMA_STATEMENTS) await sql.query(ddl);
  pool = { transaction: callback => sql.transaction(client => callback(client as unknown as SqlClient)) }; }, 30_000);
afterAll(async () => sql.close());
beforeEach(async () => {
  records = []; calls = [];
  await sql.exec(`TRUNCATE olbia.projection_state,${TABLE_NAMES.map(t => `olbia.${t}`).join(',')}`);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (13,CURRENT_TIMESTAMP),(16,CURRENT_TIMESTAMP),(17,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');
  vi.spyOn(readers, 'readerPool').mockReturnValue(sql as unknown as ReadSqlClient);
  vi.stubEnv('DSQL_OPERATIONAL_READ_MODE', 'guarded-sql');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async command => {
    calls.push(command); const input = (command as any).input;
    if (command instanceof GetCommand) return { Item: records.find(item => item.PK === input.Key.PK && item.SK === input.Key.SK) };
    if (command instanceof QueryCommand || command instanceof ScanCommand) {
      let items = records;
      if (command instanceof QueryCommand) items = items.filter(item => item.PK === input.ExpressionAttributeValues[':pk'] && String(item.SK).startsWith(input.ExpressionAttributeValues[':prefix']));
      else if (input.FilterExpression) items = items.filter(item => item.GSI1PK === input.ExpressionAttributeValues[':partition']);
      const offset = Number(input.ExclusiveStartKey?.offset ?? 0);
      return { Items: items.slice(offset, offset + 2), ...(offset + 2 < items.length ? { LastEvaluatedKey: { offset: offset + 2 } } : {}) };
    }
    throw new Error('Mutation or delivery is forbidden by read-only test');
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const sync = async () => { for (const item of records) await reconcileKey(pool, async () => item, item); };
describe('guarded operational displays and independent gate', () => {
  it('preserves Limit-before-filter exception semantics and retries/discarded state across paginated strong source reads', async () => {
    records = Array.from({ length: 104 }, (_, n) => exception(n, n === 0 ? { discarded: { by: 'owner' } } : n === 1 ? { retry: { status: 'completed' } } : n === 2 ? { retry: { status: 'queued', requestId: 'req' } } : {}));
    await sync(); const displayed = await exceptions.listExceptions();
    expect(displayed).toHaveLength(98); expect(displayed[0]).toMatchObject({ id: '2', retry: { status: 'queued' } });
    expect(displayed.at(-1)?.id).toBe('99');
    expect(calls.filter(c => c instanceof ScanCommand).length).toBe(52);
    const gate = await verify.verifyOperationalReads('owner', now, sql as never);
    expect(gate.mismatches).toBe(0); expect(gate.retained.ingestion_exceptions).toBe(104); expect(gate.targetPages).toBeGreaterThan(9);
  });
  it('falls back for stale create/edit/delete without allowing a matching public response to hide envelope corruption', async () => {
    records = [sub()]; await sync();
    const list = () => reads.readOperationalPartition('assistant_threads', { database: DynamoDBDocumentClient.prototype as never, tableName: 'test' }, 'USER#owner', 'ASSISTANT_THREAD#');
    records[0] = { ...records[0], active: false, unknown: { changed: true } };
    expect(await list()).toEqual(records);
    await sync(); await sql.query("UPDATE olbia.assistant_threads SET source_item=source_item || '{\"unknown\":false}'::jsonb");
    expect(await list()).toEqual(records);
    records = []; expect(await list()).toEqual([]);
    records = [sub(), { ...sub(), SK: 'ASSISTANT_THREAD#new', subscriptionId: 'new' }]; expect(await list()).toEqual([...records].sort((a,b) => a.SK.localeCompare(b.SK)));
  });
  it('has one bounded SQL attempt on outage, propagates source failure and skips SQL in rollback mode', async () => {
    records = [sub()]; const query = vi.fn(async () => { throw new Error('SQL outage'); });
    vi.mocked(readers.readerPool).mockReturnValue({ query });
    const list = () => reads.readOperationalPartition('assistant_threads', { database: DynamoDBDocumentClient.prototype as never, tableName: 'test' }, 'USER#owner', 'ASSISTANT_THREAD#');
    expect(await list()).toEqual(records); expect(query).toHaveBeenCalledTimes(1);
    vi.mocked(DynamoDBDocumentClient.prototype.send).mockRejectedValueOnce(new Error('source failure'));
    await expect(list()).rejects.toThrow('source failure');
    query.mockClear(); vi.stubEnv('DSQL_OPERATIONAL_READ_MODE', 'dynamodb'); expect(await list()).toEqual(records); expect(query).not.toHaveBeenCalled();
  });
  it('verifies raw columns before configured fallback, and detects unknown-field and millisecond changes', async () => {
    records = [sub(), exception(1)]; await sync();
    expect((await verify.verifyOperationalReads('owner', now, sql as never)).mismatches).toBe(0);
    await sql.query("UPDATE olbia.assistant_threads SET session_id='corrupted-session'");
    expect((await verify.verifyOperationalReads('owner', now, sql as never)).mismatches).toBeGreaterThan(0);
    await sync(); await sql.query("UPDATE olbia.assistant_threads SET created_at=created_at + interval '1 millisecond'");
    expect((await verify.verifyOperationalReads('owner', now, sql as never)).mismatches).toBeGreaterThan(0);
    await sync(); await sql.query("UPDATE olbia.ingestion_exceptions SET payload=payload || '{\"newOptional\":0}'::jsonb");
    expect((await verify.verifyOperationalReads('owner', now, sql as never)).mismatches).toBeGreaterThan(0);
  });
  it('excludes exact TTL boundaries but retains audit nested deadlines and tests actual SQL expiration filtering', async () => {
    const epoch = Math.floor(now.getTime() / 1000);
    records = [sub(), { ...sub(), SK: 'ASSISTANT_THREAD#expired', subscriptionId: 'expired', expiresAt: epoch },
      { PK: 'BULK_EDIT#owner', SK: 'OP#applied', entityType: 'bulk_edit_operation', payload: { operationId: 'applied', status: 'applied', expiresAt: 1, events: [] } }];
    await sync(); expect(records.filter(item => String(item.SK).startsWith('ASSISTANT_THREAD#') && reads.isRetainedLive(item,now))).toHaveLength(1);
    const gate = await verify.verifyOperationalReads('owner', now, sql as never);
    expect(gate.mismatches).toBe(0); expect(gate.retained.bulk_edit_operations).toBe(1); expect(gate.expirationChecks).toBeGreaterThan(9);
  });
  it('keeps exception retry on its authoritative path regardless of display read mode', async () => {
    const query = vi.spyOn(sql, 'query');
    await expect(exceptions.requestRetry('missing', 'owner')).rejects.toThrow('Exception not found');
    expect(query).not.toHaveBeenCalled();
  });
});

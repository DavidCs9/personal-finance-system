import { PGlite } from '@electric-sql/pglite';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { maintenanceHandler, replayHandler, streamHandler, schemaHandler, createPool, type MaintenanceInput } from '../src/dsql/runtime.js';
import type { SourceItem, SourceKey } from '../src/dsql/model.js';

const keyId = (key: SourceKey): string => JSON.stringify([key.PK, key.SK]);
const sources = new Map<string, SourceItem>();
const objects = new Map<string, string>();
let sql: PGlite;
let reads = 0;
const sourceItem = (index: number): SourceItem => ({ PK: `EVENT#${index}`, SK: 'EVENT', entityType: 'observed_purchase',
  payload: { id: String(index), institution: 'santander_mx', eventType: 'card_purchase', status: 'accepted',
    amount: { amountMinor: index * 100, currency: 'MXN' }, merchantRaw: 'Merchant', receivedAt: '2026-09-30T20:00:00Z', tags: ['personal'] },
});
beforeAll(async () => {
  vi.stubEnv('DSQL_ENDPOINT', 'example.dsql.us-east-2.on.aws');
  vi.stubEnv('METADATA_TABLE_NAME', 'source'); vi.stubEnv('DSQL_RECOVERY_BUCKET', 'recovery');
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  vi.spyOn(AuroraDSQLPool.prototype, 'connect').mockImplementation(async () => ({
    query: (statement: string, params?: unknown[]) => sql.query(statement, params), release: () => {},
  }) as never);
  vi.spyOn(AuroraDSQLPool.prototype, 'query').mockImplementation(((statement: string, params?: unknown[]) => sql.query(statement, params)) as never);
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation((async (command: { constructor: { name: string }; input: { Key?: SourceKey; ExclusiveStartKey?: SourceKey; Limit?: number; ConsistentRead?: boolean } }) => {
    expect(command.input.ConsistentRead).toBe(true);
    if (command.constructor.name === 'GetCommand') { reads++; return { Item: sources.get(keyId(command.input.Key!)) }; }
    if (command.constructor.name === 'ScanCommand') {
      const items = [...sources.values()]; const start = command.input.ExclusiveStartKey ? items.findIndex((item) => keyId(item) === keyId(command.input.ExclusiveStartKey!)) + 1 : 0;
      const page = items.slice(start, start + (command.input.Limit ?? 25));
      const key = (item: SourceItem): SourceKey => ({ PK: item.PK, SK: item.SK });
      return { Items: page.map(key), LastEvaluatedKey: start + page.length < items.length ? key(page.at(-1)!) : undefined };
    }
    throw new Error('Source writes are forbidden');
  }) as never);
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: { constructor: { name: string }; input: { Key: string; Body?: string } }) => {
    if (command.constructor.name === 'PutObjectCommand') { objects.set(command.input.Key, command.input.Body!); return {}; }
    if (command.constructor.name === 'GetObjectCommand') return { Body: { transformToString: async () => objects.get(command.input.Key) } };
    throw new Error('Unexpected S3 operation');
  }) as never);
}, 30_000);
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await sql.close(); });
const complete = async (runId: string): Promise<MaintenanceInput> => {
  let input: MaintenanceInput = { runId, phase: 'source', cursor: null, projected: 0, equal: 0, lag: 0, mismatch: 0 };
  let pages = 0;
  do { input = await maintenanceHandler(input); expect(++pages).toBeLessThan(30); } while (input.phase !== 'done');
  return input;
};
describe('deployed DSQL maintenance and recovery flow', () => {
  it('boots historical keys through multiple pages and verifies every relational row with the official transaction wrapper', async () => {
    for (let index = 1; index <= 32; index++) { const item = sourceItem(index); sources.set(keyId(item), item); }
    const rule = { PK: 'CATEGORY_RULES', SK: 'RULE#merchant', id: 'rule', merchantKey: 'merchant', categoryId: 'shopping', source: 'human' };
    sources.set(keyId(rule), rule);
    const result = await complete('initial');
    expect(result).toMatchObject({ phase: 'done', lag: 0, mismatch: 0 });
    expect(result.equal).toBeGreaterThan(32);
    expect((await sql.query('SELECT * FROM olbia.movements')).rows).toHaveLength(32);
    expect((await sql.query('SELECT * FROM olbia.merchant_category_rules')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.categories')).rows.length).toBeGreaterThan(1);
    const report = [...objects.values()].map((value) => JSON.parse(value)).find((value) => value.runId === 'initial');
    expect(report).toMatchObject({ phase: 'done', lag: 0, mismatch: 0 });
    expect(JSON.stringify(report)).not.toContain('Merchant');
  });
  it('repairs deletions missed by the stream, then replays retained failures using the live item', async () => {
    const removed = sourceItem(1); sources.delete(keyId(removed));
    const updated = sourceItem(2); (updated.payload as Record<string, unknown>).status = 'rejected'; sources.set(keyId(updated), updated);
    const failureKey = 'aws/lambda/projector/failed.json';
    objects.set(failureKey, JSON.stringify({ payload: JSON.stringify({ Records: [{ eventName: 'MODIFY', dynamodb: { Keys: { PK: { S: updated.PK }, SK: { S: updated.SK } }, SequenceNumber: '123', NewImage: { stale: true } } }] }) }));
    expect(await replayHandler({ key: failureKey })).toEqual({ replayed: 1 });
    expect(objects.has(failureKey)).toBe(true);
    const result = await complete('recovery');
    expect(result).toMatchObject({ lag: 0, mismatch: 0, summary: { capturedKeys: '1' } });
    expect((await sql.query("SELECT id FROM olbia.movements WHERE id='1'")).rows).toEqual([]);
    expect((await sql.query("SELECT status FROM olbia.movements WHERE id='2'")).rows).toEqual([{ status: 'rejected' }]);
    expect((await sql.query("SELECT deleted FROM olbia.projection_state WHERE source_pk='EVENT#1'")).rows).toEqual([{ deleted: true }]);
  });
  it('has no database side effects on CloudFormation Delete and rejects non-native replay keys', async () => {
    const connections = vi.mocked(AuroraDSQLPool.prototype.connect).mock.calls.length;
    expect(await schemaHandler({ RequestType: 'Delete', ResourceProperties: {} })).toMatchObject({ PhysicalResourceId: 'olbia-dsql-schema-v1' });
    expect(vi.mocked(AuroraDSQLPool.prototype.connect).mock.calls).toHaveLength(connections);
    await expect(replayHandler({ key: 'reconciliation/anything' })).rejects.toThrow('Expected native');
  });
  it('retries OCC by rerunning the official callback, but leaves failed records retryable for other SQL errors', async () => {
    const original = sql.query.bind(sql); let fail = true; const before = reads;
    const spy = vi.spyOn(sql, 'query').mockImplementation(async (statement, params, options) => {
      if (statement === 'COMMIT' && fail) { fail = false; throw { code: '40001' }; }
      return original(statement, params, options);
    });
    const item = sourceItem(3);
    const record = { dynamodb: { Keys: { PK: { S: item.PK }, SK: { S: item.SK } }, SequenceNumber: '3' } };
    expect(await streamHandler({ Records: [record] })).toEqual({ batchItemFailures: [] });
    expect(reads - before).toBe(2); spy.mockRestore();
    // The configuration itself is validated by the official connector transaction().
    const native = createPool(); await native.transaction(async (client) => { await client.query('SELECT 1'); }); await native.end();
    const sqlFailure = vi.spyOn(sql, 'query').mockImplementation(async (statement, params, options) => {
      if (String(statement).startsWith('UPDATE olbia.projection_state')) throw { code: '42601', detail: 'private financial payload' };
      return original(statement, params, options);
    });
    expect(await streamHandler({ Records: [record] })).toEqual({ batchItemFailures: [{ itemIdentifier: '3' }] });
    await expect(maintenanceHandler({ runId: 'failed', phase: 'source' })).rejects.toThrow('DSQL maintenance failed (42601)');
    sqlFailure.mockRestore();

  });
});

it('ignores stale DynamoDB stream data after SQL authority and verifies SQL envelopes without rewriting them',async()=>{
  const beforeReads=reads;
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  const before=(await sql.query('SELECT source_pk,source_sk,generation,source_hash FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows;
  expect(await streamHandler({Records:[{dynamodb:{Keys:{PK:{S:'EVENT#1'},SK:{S:'EVENT'}},SequenceNumber:'stale'}}]})).toEqual({batchItemFailures:[]});
  const result=await complete('sql-authority');
  expect(result).toMatchObject({phase:'done',lag:0,mismatch:0,projected:0});expect(reads).toBe(beforeReads);
  expect((await sql.query('SELECT source_pk,source_sk,generation,source_hash FROM olbia.projection_state ORDER BY source_pk,source_sk')).rows).toEqual(before);
});

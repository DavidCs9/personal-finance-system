import { GetCommand, QueryCommand, paginateScan, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead, type LedgerReadMode } from '../events/read-selection.js';
import type { JsonObject } from '../http/response.js';

export type OperationalDisplayTable = 'ingestion_exceptions' | 'import_records';
export const operationalReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_OPERATIONAL_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};
export const isRetainedLive = (item: JsonObject, at: Date): boolean =>
  typeof item.expiresAt !== 'number' || item.expiresAt > Math.floor(at.getTime() / 1000);
export type SourceStore = { database: DynamoDBDocumentClient; tableName: string };
export const sourceOperationalItem = async (store: SourceStore, PK: string, SK: string): Promise<JsonObject | undefined> =>
  (await store.database.send(new GetCommand({ TableName: store.tableName, Key: { PK, SK }, ConsistentRead: true }))).Item;
export const sourceOperationalPartition = async (store: SourceStore, PK: string, prefix: string): Promise<JsonObject[]> => {
  const items: JsonObject[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await store.database.send(new QueryCommand({ TableName: store.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix }, ConsistentRead: true, ExclusiveStartKey: cursor }));
    items.push(...page.Items ?? []); cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
};
export const sourceExceptionRecords = async (store: SourceStore): Promise<JsonObject[]> => {
  const items: JsonObject[] = [];
  for await (const page of paginateScan({ client: store.database }, { TableName: store.tableName, ConsistentRead: true,
    FilterExpression: 'GSI1PK = :partition', ExpressionAttributeValues: { ':partition': 'EXCEPTIONS' } })) items.push(...page.Items ?? []);
  return items;
};
// Select envelopes before public rendering; optional/unknown fields and TTL cannot be hidden by a lossy mapper.
const keySort = (items: readonly JsonObject[]) => [...items].sort((a, b) => Buffer.compare(Buffer.from(`${a.PK}\0${a.SK}`), Buffer.from(`${b.PK}\0${b.SK}`)));
export const sqlOperationalPartition = async (table: OperationalDisplayTable, PK: string, prefix: string, client: ReadSqlClient = readerPool()): Promise<JsonObject[]> => {
  return (await client.query(`SELECT source_item FROM olbia.${table} WHERE source_pk=$1 AND source_sk >= $2 AND source_sk < $3 ORDER BY source_sk COLLATE "C"`, [PK, prefix, `${prefix.slice(0, -1)}$`])).rows.map(row => row.source_item as JsonObject);
};
export const selectOperationalRecords = async (table: OperationalDisplayTable, source: () => Promise<JsonObject[]>, sql: () => Promise<JsonObject[]>): Promise<JsonObject[]> => {
  const mode = operationalReadMode();
  return selectLedgerRead({ mode, sql: async () => keySort(await sql()), source: async () => keySort(await source()),
    report: (outcome, selected) => observe('operational-list', mode, outcome, selected) });
};
export const readOperationalPartition = (table: OperationalDisplayTable, store: SourceStore, PK: string, prefix: string) =>
  selectOperationalRecords(table, () => sourceOperationalPartition(store, PK, prefix), () => sqlOperationalPartition(table, PK, prefix));
export const readOperationalItem = async (table: OperationalDisplayTable, store: SourceStore, PK: string, SK: string): Promise<JsonObject | undefined> => {
  const mode = operationalReadMode();
  return selectLedgerRead({ mode, source: () => sourceOperationalItem(store, PK, SK),
    sql: async () => (await readerPool().query(`SELECT source_item FROM olbia.${table} WHERE source_pk=$1 AND source_sk=$2`, [PK, SK])).rows[0]?.source_item as JsonObject | undefined,
    report: (outcome, selected) => observe('operational-detail', mode, outcome, selected) });
};
export const publicExceptions = (items: readonly JsonObject[], at: Date, preserveOrder = false): JsonObject[] => (preserveOrder ? [...items] : [...items]
  .sort((a, b) => Buffer.compare(Buffer.from(String(b.GSI1SK)), Buffer.from(String(a.GSI1SK)))
    || Buffer.compare(Buffer.from(`${b.PK}\0${b.SK}`), Buffer.from(`${a.PK}\0${a.SK}`))))
  // Existing query Limit=100 is evaluated BEFORE hiding discarded/completed exceptions.
  .slice(0, 100).filter(item => isRetainedLive(item, at)).map(item => item.payload as JsonObject)
  .filter(p => !p.discarded && (p.retry as JsonObject | undefined)?.status !== 'completed')
  .map(p => { const retry = p.retry as JsonObject | undefined; return { id: p.id, receivedAt: p.receivedAt, institution: p.institution,
    reason: p.reason, details: p.details, ...(retry?.status === 'queued' || retry?.status === 'completed' ? { retry } : {}) }; });

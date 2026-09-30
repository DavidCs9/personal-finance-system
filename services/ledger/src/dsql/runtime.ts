import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';
import { canonicalJson, entityForKey, projectRows, TABLE_NAMES, PROJECTION_VERSION, type SourceItem, type SourceKey } from './model.js';
import { processStream, reconcileKey, type TransactionPool, type SqlClient, type StreamDelivery } from './projection.js';
import { verifyKeyDetails } from './verification.js';
import { bootstrapSchema } from './schema.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
export const createPool = (user = 'olbia_projector'): AuroraDSQLPool => new AuroraDSQLPool({
  host: required('DSQL_ENDPOINT'), user, database: 'postgres', max: 2,
  ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000, maxLifetimeSeconds: 300, statement_timeout: 20_000,
  retry: { maxRetries: 4, baseDelayMs: 25, maxDelayMs: 100 },
  // Driver errors can contain parameter values. Native Lambda/ESM metrics expose failures.
  logger: { warn: () => {}, error: () => {} },
});
let pool: AuroraDSQLPool | undefined;
const runtimePool = (): TransactionPool => pool ??= createPool();
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const readSource = async (key: SourceKey): Promise<SourceItem | undefined> => {
  const result = await database.send(new GetCommand({ TableName: required('METADATA_TABLE_NAME'), Key: { PK: key.PK, SK: key.SK }, ConsistentRead: true }));
  return result.Item as SourceItem | undefined;
};
const reconcile = (key: SourceKey, delivery?: StreamDelivery): Promise<void> => reconcileKey(runtimePool(), readSource, key, delivery);
export const streamHandler = (event: { Records: Parameters<typeof processStream>[0] }): ReturnType<typeof processStream> =>
  processStream(event.Records, reconcile);

export const schemaHandler = async (event: {
  RequestType: string; PhysicalResourceId?: string;
  ResourceProperties: { RuntimeRoleArns?: string[] };
}): Promise<{ PhysicalResourceId: string }> => {
  const PhysicalResourceId = event.PhysicalResourceId ?? 'olbia-dsql-schema-v1';
  if (event.RequestType === 'Delete') return { PhysicalResourceId };
  const admin = createPool('admin');
  try {
    const client = await admin.connect();
    try { await bootstrapSchema(client as SqlClient, event.ResourceProperties.RuntimeRoleArns ?? []); }
    finally { client.release(); }
    // Real engine / non-admin IAM smoke, before enabling the event source.
    const runtime = createPool();
    try {
      const version = await runtime.query('SELECT version FROM olbia.schema_migrations WHERE version=$1', [PROJECTION_VERSION]);
      if (version.rows.length !== 1) throw new Error('Schema smoke failed');
    } finally { await runtime.end(); }
  } catch {
    throw new Error('DSQL bootstrap or runtime IAM smoke failed; inspect native platform metrics');
  } finally { await admin.end(); }
  return { PhysicalResourceId };
};

export type MaintenanceProgress = {
  phase: 'source' | 'target' | 'verify-source' | 'verify-target' | 'done';
  cursor?: SourceKey | null; projected?: number; equal?: number; lag?: number; mismatch?: number;
  sourceTotals?: Record<string, { count: number; amountMinor: string; personalAmountMinor: string }>;
  summary?: Record<string, unknown>;
};
export type MaintenanceInput = MaintenanceProgress & { runId: string };

const runMaintenance = async (event: MaintenanceInput): Promise<MaintenanceInput> => {
  const runId = event.runId;
  if (typeof runId !== 'string' || !runId) throw new Error('runId is required');
  const input: MaintenanceInput = { ...event, projected: event.projected ?? 0, equal: event.equal ?? 0, lag: event.lag ?? 0, mismatch: event.mismatch ?? 0, sourceTotals: { ...event.sourceTotals } };
  let keys: SourceKey[];
  let cursor: SourceKey | undefined;
  if (input.phase === 'source' || input.phase === 'verify-source') {
    const page = await database.send(new ScanCommand({
      TableName: required('METADATA_TABLE_NAME'), ConsistentRead: true, Limit: 25,
      ProjectionExpression: 'PK,SK', ExclusiveStartKey: input.cursor ?? undefined,
    }));
    keys = (page.Items ?? []).map((key) => ({ PK: String(key.PK), SK: String(key.SK) })).filter((key) => entityForKey(key));
    cursor = page.LastEvaluatedKey as SourceKey | undefined;
    if (!input.cursor) keys.push(...DEFAULT_SPEND_CATEGORIES.map((category) => ({ PK: 'CATEGORY_CATALOG', SK: `CAT#${category.id}` })));
  } else if (input.phase === 'target' || input.phase === 'verify-target') {
    const page = await (pool ??= createPool()).query(`SELECT source_pk,source_sk FROM olbia.projection_state
      WHERE (source_pk,source_sk) > ($1,$2) ORDER BY source_pk,source_sk LIMIT 25`, [input.cursor?.PK ?? '', input.cursor?.SK ?? '']);
    keys = page.rows.map((row) => ({ PK: String(row.source_pk), SK: String(row.source_sk) }));
    cursor = keys.length === 25 ? keys.at(-1) : undefined;
  } else throw new Error('Invalid reconciliation phase');
  for (const key of keys) {
    if (input.phase.startsWith('verify')) {
      const result = await verifyKeyDetails(runtimePool(), readSource, key);
      input[result.status] = (input[result.status] ?? 0) + 1;
      if (input.phase === 'verify-source' && result.source && entityForKey(key) === 'movements') {
        const movement = projectRows(key, result.source)[0].values;
        const group = JSON.stringify([movement.spend_month, movement.currency]);
        const previous = input.sourceTotals![group] ?? { count: 0, amountMinor: '0', personalAmountMinor: '0' };
        input.sourceTotals![group] = { count: previous.count + 1,
          amountMinor: (BigInt(previous.amountMinor) + BigInt(String(movement.amount_minor))).toString(),
          personalAmountMinor: (BigInt(previous.personalAmountMinor) + BigInt(String(movement.personal_amount_minor ?? movement.amount_minor))).toString() };
      }
    } else {
      await reconcile(key);
      input.projected = (input.projected ?? 0) + 1;
    }
  }
  const next = { source: 'target', target: 'verify-source', 'verify-source': 'verify-target', 'verify-target': 'done' } as const;
  const output: MaintenanceInput = { ...input, phase: cursor ? input.phase : next[input.phase as keyof typeof next], cursor: cursor ?? null };
  if (output.phase === 'done') {
    const summary = await runtimePool().transaction(async (client) => {
      const tableCounts: Record<string, string> = {};
      for (const table of TABLE_NAMES) {
        const count = await client.query(`SELECT count(*) AS count FROM olbia.${table}`);
        tableCounts[table] = String(count.rows[0].count);
      }
      const totals = await client.query(`SELECT spend_month,currency,count(*) AS count,
        sum(amount_minor) AS amount_minor,sum(coalesce(personal_amount_minor,amount_minor)) AS personal_amount_minor
        FROM olbia.movements GROUP BY spend_month,currency`);
      const sqlTotals = Object.fromEntries(totals.rows.map((row) => [JSON.stringify([row.spend_month, row.currency]), {
        count: Number(row.count), amountMinor: String(row.amount_minor), personalAmountMinor: String(row.personal_amount_minor),
      }]));
      const captured = await client.query('SELECT count(*) AS count, max(stream_delivered_at) AS latest FROM olbia.projection_state WHERE stream_sequence IS NOT NULL');
      return { tableCounts, sqlTotals, capturedKeys: String(captured.rows[0].count), latestStreamDelivery: captured.rows[0].latest };
    });
    output.summary = summary;
    if (canonicalJson(summary.sqlTotals) !== canonicalJson(output.sourceTotals)) output.lag = (output.lag ?? 0) + 1;
  }
  // No source payloads: auditable progress survives retries, resumable at a saved cursor.
  const runKey = createHash('sha256').update(runId).digest('hex');
  await s3.send(new PutObjectCommand({ Bucket: required('DSQL_RECOVERY_BUCKET'), Key: `reconciliation/${runKey}/progress.json`, Body: JSON.stringify({ ...output, checkedAt: new Date().toISOString() }), ContentType: 'application/json' }));
  return output;
};

// Replay uses the original failed batch only to recover keys, and reads live DDB.
// Operators invoke this deployed capability; it never modifies the source table.
const runReplay = async (event: { key: string }): Promise<{ replayed: number }> => {
  if (typeof event.key !== 'string' || !event.key.startsWith('aws/lambda/')) throw new Error('Expected native Lambda failure object key');
  const object = await s3.send(new GetObjectCommand({ Bucket: required('DSQL_RECOVERY_BUCKET'), Key: event.key }));
  const body = JSON.parse(await object.Body!.transformToString());
  const rawPayload = body.payload ?? body.requestPayload;
  const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  if (!Array.isArray(payload?.Records)) throw new Error('Invalid failure payload');
  const result = await processStream(payload.Records, reconcile);
  if (result.batchItemFailures.length) throw new Error('Replay incomplete; original object retained');
  return { replayed: payload.Records.length };
};

// Lambda otherwise logs uncaught driver errors, which can include failing rows.
const sanitizedFailure = (error: unknown): Error => {
  const code = (error as { code?: unknown })?.code;
  return new Error(`DSQL maintenance failed (${typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : 'operation'}); retained progress can be resumed`);
};
export const maintenanceHandler = async (event: MaintenanceInput): Promise<MaintenanceInput> => {
  try { return await runMaintenance(event); } catch (error) { throw sanitizedFailure(error); }
};
export const replayHandler = async (event: { key: string }): Promise<{ replayed: number }> => {
  if (typeof event.key !== 'string' || !event.key.startsWith('aws/lambda/')) throw new Error('Expected native Lambda failure object key');
  try { return await runReplay(event); } catch (error) { throw sanitizedFailure(error); }
};

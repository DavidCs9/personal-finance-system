import type { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { DEFAULT_SPEND_CATEGORIES } from '@finance/domain';
import { canonicalJson, entityForKey, projectRows, TABLE_NAMES, PROJECTION_VERSION, type SourceItem, type SourceKey } from './model.js';
import { processStream, reconcileKey, type TransactionPool, type SqlClient, type StreamDelivery } from './projection.js';
import { verifyKeyDetails } from './verification.js';
import { bootstrapSchema, BootstrapFailure } from './schema.js';
import { createPool } from './connection.js';
import { authorityFrom } from './store.js';
export { createPool } from './connection.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
let pool: AuroraDSQLPool | undefined;
const runtimePool = (): TransactionPool & SqlClient => pool ??= createPool();
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const readSource = async (key: SourceKey): Promise<SourceItem | undefined> => {
  if(await authorityFrom(pool ??= createPool())==='sql') {
    const rows=(await pool!.query('SELECT source_item FROM olbia.projection_state WHERE source_pk=$1 AND source_sk=$2 AND deleted=false',[key.PK,key.SK])).rows;return rows[0]?.source_item as SourceItem|undefined;
  }
  const result = await database.send(new GetCommand({ TableName: required('METADATA_TABLE_NAME'), Key: { PK: key.PK, SK: key.SK }, ConsistentRead: true }));
  return result.Item as SourceItem | undefined;
};
const reconcile = (key: SourceKey, delivery?: StreamDelivery): Promise<void> => reconcileKey({transaction: callback => runtimePool().transaction(async client => {
  await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
  if(await authorityFrom(client)==='sql') return undefined as never;
  return callback(client);
})}, readSource, key, delivery);
export const streamHandler = async (event: { Records: Parameters<typeof processStream>[0] }): ReturnType<typeof processStream> => {
  if(await authorityFrom(pool ??= createPool())==='sql') return {batchItemFailures:[]};
  return processStream(event.Records,reconcile);
};

export const schemaHandler = async (event: {
  RequestType: string; PhysicalResourceId?: string;
  ResourceProperties: { RuntimeRoleArns?: string[]; ReaderRoleArns?: string[]; OperationalVerifierRoleArns?: string[]; ApplicationRoleArns?: string[]; StoreReaderRoleArns?: string[]; CutoverRoleArns?: string[] };
}): Promise<{ PhysicalResourceId: string }> => {
  const PhysicalResourceId = event.PhysicalResourceId ?? 'olbia-dsql-schema-v1';
  if (event.RequestType === 'Delete') return { PhysicalResourceId };
  const admin = createPool('admin');
  let stage = 'admin-connect';
  try {
    const client = await admin.connect();
    try { await bootstrapSchema(client as SqlClient, event.ResourceProperties.RuntimeRoleArns ?? [], {
      transactionPool: admin, readerRoleArns: event.ResourceProperties.ReaderRoleArns, operationalVerifierRoleArns: event.ResourceProperties.OperationalVerifierRoleArns,
      applicationRoleArns: event.ResourceProperties.ApplicationRoleArns,storeReaderRoleArns:event.ResourceProperties.StoreReaderRoleArns,cutoverRoleArns:event.ResourceProperties.CutoverRoleArns,
    }); }
    finally { client.release(); }
    // Real engine / non-admin IAM smoke, before enabling the event source.
    stage = 'runtime-connect-and-smoke';
    const runtime = createPool();
    try {
      const version = await runtime.query('SELECT version FROM olbia.schema_migrations WHERE version=$1', [PROJECTION_VERSION]);
      if (version.rows.length !== 1) throw new Error('Schema smoke failed');
    } finally { await runtime.end(); }
  } catch (error) {
    throw error instanceof BootstrapFailure ? error : new BootstrapFailure(stage, error);
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
  const sqlAuthority=await authorityFrom(pool ??= createPool())==='sql';
  if(sqlAuthority && !event.phase.startsWith('verify') && event.phase!=='done') event={...event,phase:event.phase==='source'?'verify-source':'verify-target'};
  const input: MaintenanceInput = { ...event, projected: event.projected ?? 0, equal: event.equal ?? 0, lag: event.lag ?? 0, mismatch: event.mismatch ?? 0, sourceTotals: { ...event.sourceTotals } };
  let keys: SourceKey[];
  let cursor: SourceKey | undefined;
  if (input.phase === 'source' || input.phase === 'verify-source') {
    const page = sqlAuthority ? await (async () => {
      const result=await pool!.query('SELECT source_pk,source_sk FROM olbia.projection_state WHERE deleted=false AND (source_pk,source_sk)>($1,$2) ORDER BY source_pk,source_sk LIMIT 25',[input.cursor?.PK??'',input.cursor?.SK??'']);
      const Items=result.rows.map(row=>({PK:String(row.source_pk),SK:String(row.source_sk)}));return {Items,LastEvaluatedKey:Items.length===25?Items.at(-1):undefined};
    })() : await database.send(new ScanCommand({
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
      for (const table of ['month_plans','planned_payments','payslips','payslip_lines','bank_imports','bank_import_rows','bank_import_candidates']) tableCounts[table] = String((await client.query(`SELECT count(*) AS count FROM olbia.${table}`)).rows[0].count);
      tableCounts.card_profiles = String((await client.query('SELECT count(*) AS count FROM olbia.card_profiles')).rows[0].count);
      tableCounts.spend_categories = String((await client.query('SELECT count(*) AS count FROM olbia.spend_categories')).rows[0].count);
      tableCounts.merchant_rules = String((await client.query('SELECT count(*) AS count FROM olbia.merchant_rules')).rows[0].count);
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

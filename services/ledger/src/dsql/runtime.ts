import type { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { isOCCError } from '@aws/aurora-dsql-node-postgres-connector';
import { DynamoDBClient, DescribeTableCommand, DescribeContinuousBackupsCommand } from '@aws-sdk/client-dynamodb';
import { bootstrapSchema, BootstrapFailure } from './schema.js';
import type { SqlClient } from './projection.js';
import { createPool } from './connection.js';
import { inspectNativeCatalog, retireMigrationEvidence } from './catalog-retirement.js';
import { CURRENT_SQL_TABLES } from './catalog.js';
import { NATIVE_LEDGER_TABLES } from './ledger-schema.js';
export { createPool } from './connection.js';
const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
let pool: AuroraDSQLPool | undefined;
const database = new DynamoDBClient({});
/** Retired stream mapping stays disabled. Stale deliveries cannot recreate migration data. */
export const streamHandler = async (_event: { Records: unknown[] }) => ({ batchItemFailures: [] });
/** Recovery is the retained DynamoDB source and native backups, not document projection into DSQL. */
export const replayHandler = async (_event: { key: string }): Promise<never> => { throw new Error('DSQL migration replay is retired'); };
export const schemaHandler = async (event: {
  action?: 'retire-migration-evidence'; RequestType?: string; PhysicalResourceId?: string;
  ResourceProperties?: { RuntimeRoleArns?: string[]; ReaderRoleArns?: string[]; OperationalVerifierRoleArns?: string[]; ApplicationRoleArns?: string[]; StoreReaderRoleArns?: string[]; CutoverRoleArns?: string[] };
}): Promise<Record<string, unknown>> => {
  if (event.action === 'retire-migration-evidence') {
    const admin = createPool('admin');
    try {
      // One autocommit DDL statement per connector retry; never mix DDL and DML.
      return await retireMigrationEvidence({ query: async (statement, values) => {
        for (let attempt = 0; ; attempt++) {
          try { return await admin.query(statement, values); }
          catch (error) { if (!isOCCError(error) || attempt >= 4) throw error; }
        }
      } }, async () => {
        const TableName = required('METADATA_TABLE_NAME');
        const table = await database.send(new DescribeTableCommand({ TableName }));
        const recovery = await database.send(new DescribeContinuousBackupsCommand({ TableName }));
        if (table.Table?.TableStatus !== 'ACTIVE' || table.Table.DeletionProtectionEnabled !== true
          || recovery.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus !== 'ENABLED')
          throw new Error('Retained DynamoDB recovery is not ready');
      });
    } catch { throw new Error('DSQL catalog retirement failed; inspect deployment state and retry the reviewed release'); }
    finally { await admin.end(); }
  }
  const PhysicalResourceId = event.PhysicalResourceId ?? 'olbia-dsql-schema-v1';
  if (event.RequestType === 'Delete') return { PhysicalResourceId };
  if (!['Create','Update'].includes(event.RequestType ?? '') || !event.ResourceProperties) throw new Error('Unknown DSQL schema operation');
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
      const version = await runtime.query('SELECT version FROM olbia.schema_migrations WHERE version=20');
      if (version.rows.length !== 1 || (await runtime.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows.length !== 1) throw new Error('Schema smoke failed');
      for (const table of NATIVE_LEDGER_TABLES) await runtime.query(`SELECT 1 FROM olbia.${table} LIMIT 1`);
    } finally { await runtime.end(); }
  } catch (error) {
    throw error instanceof BootstrapFailure ? error : new BootstrapFailure(stage, error);
  } finally { await admin.end(); }
  return { PhysicalResourceId };
};


export type MaintenanceInput = { runId: string; phase: string; cursor?: unknown; projected?: number; equal?: number; lag?: number; mismatch?: number; sourceTotals?: unknown; summary?: unknown };
/** Stable managed verification resource now inspects current SQL only; no copies, source scans or evidence reports. */
export const maintenanceHandler = async (event: MaintenanceInput): Promise<MaintenanceInput> => {
  if (typeof event.runId !== 'string' || !event.runId) throw new Error('runId is required');
  pool ??= createPool();
  try {
    const catalog = await pool.transaction(async client => {
      const catalog = await inspectNativeCatalog(client);
      for (const table of CURRENT_SQL_TABLES) await client.query(`SELECT 1 FROM olbia.${table} LIMIT 1`);
      return catalog;
    });
    return { runId: event.runId, phase: 'done', cursor: null, projected: 0, equal: catalog.current.length, lag: 0, mismatch: 0,
      summary: { mode: 'native-sql', tables: catalog.current.length, nativeColumns: catalog.columns, nativeConstraints: catalog.constraints } };
  } catch { throw new Error('Native DSQL catalog verification failed'); }
};

import { createHash } from 'node:crypto';
import { canonicalJson, entityForKey, projectRows, PROJECTION_VERSION, tablesForKey, type SourceItem, type SourceKey, type SqlRow } from './model.js';

export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface TransactionPool {
  transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T>;
}
export type StreamDelivery = { sequence: string; streamArn?: string };
export type ReadSource = (key: SourceKey) => Promise<SourceItem | undefined>;
export const sourceHash = (item?: SourceItem): string | null => item
  ? createHash('sha256').update(canonicalJson(item)).digest('hex') : null;

export const insertRow = async (client: SqlClient, row: SqlRow): Promise<void> => {
  const columns = Object.keys(row.values);
  await client.query(`INSERT INTO olbia.${row.table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row.values).map((value) => value && typeof value === 'object' ? JSON.stringify(value) : value));
};

/** Read SQL before DDB on EVERY transaction attempt; always write the checkpoint.
 * A competing write to the same source key forces an OCC abort. A new attempt
 * re-reads DDB. Sequence numbers / timestamps / old stream images aren't versions.
 */
export const reconcileKey = async (pool: TransactionPool, readSource: ReadSource, key: SourceKey, delivery?: StreamDelivery): Promise<void> => {
  key = { PK: key.PK, SK: key.SK };
  if (!entityForKey(key)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.transaction(async (client) => {
        const checkpoint = await client.query('SELECT generation FROM olbia.projection_state WHERE source_pk=$1 AND source_sk=$2', [key.PK, key.SK]);
        const current = await readSource(key);
        const rows = projectRows(key, current);
        const generation = BigInt(String(checkpoint.rows[0]?.generation ?? '0')) + 1n;
        if (checkpoint.rows.length) {
          await client.query(`UPDATE olbia.projection_state SET generation=$3, source_hash=$4, source_item=$5,
            deleted=$6, transformer_version=$7, reconciled_at=CURRENT_TIMESTAMP,
            stream_sequence=coalesce($8,stream_sequence),stream_arn=coalesce($9,stream_arn),
            stream_delivered_at=CASE WHEN $8::text IS NULL THEN stream_delivered_at ELSE CURRENT_TIMESTAMP END WHERE source_pk=$1 AND source_sk=$2`,
          [key.PK, key.SK, generation.toString(), sourceHash(current), current ? JSON.stringify(current) : null, !current, PROJECTION_VERSION, delivery?.sequence ?? null, delivery?.streamArn ?? null]);
        } else {
          await client.query(`INSERT INTO olbia.projection_state
            (source_pk,source_sk,generation,source_hash,source_item,deleted,transformer_version,reconciled_at,stream_sequence,stream_arn,stream_delivered_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8,$9,CASE WHEN $8::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)`,
          [key.PK, key.SK, generation.toString(), sourceHash(current), current ? JSON.stringify(current) : null, !current, PROJECTION_VERSION, delivery?.sequence ?? null, delivery?.streamArn ?? null]);
        }
        for (const table of tablesForKey(key)) {
          await client.query(`DELETE FROM olbia.${table} WHERE source_pk=$1 AND source_sk=$2`, [key.PK, key.SK]);
        }
        for (const row of rows) await insertRow(client, row);
      });
      return;
    } catch (error) {
      // A first-insert race can report a PK violation rather than OCC. Retry only
      // this checkpoint constraint; validation and unrelated SQL errors propagate.
      const sqlError = error as { code?: string; constraint?: string };
      if (attempt >= 3 || sqlError.code !== '23505' || sqlError.constraint !== 'projection_state_pkey') throw error;
    }
  }
};

export const processStream = async (records: readonly {
  eventSourceARN?: string;
  dynamodb?: { Keys?: Record<string, { S?: string }>; SequenceNumber?: string };
}[], reconcile: (key: SourceKey, delivery: StreamDelivery) => Promise<void>): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  for (const record of records) {
    const sequence = record.dynamodb?.SequenceNumber;
    const pk = record.dynamodb?.Keys?.PK?.S;
    const sk = record.dynamodb?.Keys?.SK?.S;
    if (!sequence || !pk || !sk) throw new Error('Invalid stream record envelope');
    try {
      if (entityForKey({ PK: pk, SK: sk })) await reconcile({ PK: pk, SK: sk }, { sequence, streamArn: record.eventSourceARN });
    } catch {
      // Retry from the first failed sequence, preserving ordering in this batch.
      // No financial payload or driver error text is logged.
      return { batchItemFailures: [{ itemIdentifier: sequence }] };
    }
  }
  return { batchItemFailures: [] };
};

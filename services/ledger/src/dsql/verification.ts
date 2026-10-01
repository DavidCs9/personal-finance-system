import { canonicalJson, projectRows, tablesForKey, TABLE_COLUMNS, PROJECTION_VERSION, type SourceKey, type SqlRow } from './model.js';
import { sourceHash, type ReadSource, type SqlClient, type TransactionPool } from './projection.js';

const normalizedRow = (row: SqlRow): SqlRow => ({
  table: row.table,
  values: Object.fromEntries(Object.entries(row.values).map(([column, value]) => {
    const type = (TABLE_COLUMNS[row.table] as Record<string, string>)[column];
    if (value != null && type === 'bigint') return [column, String(value)];
    // node-postgres returns Date objects. String(Date) discards milliseconds.
    if (value != null && type === 'timestamptz') return [column, (value instanceof Date ? value : new Date(String(value))).toISOString()];
    if (value instanceof Date && type === 'date') return [column, value.toISOString().slice(0, 10)];
    return [column, value];
  })),
});
const rowSignature = (rows: SqlRow[]): string => canonicalJson(rows.map(normalizedRow)
  .sort((a, b) => `${a.table}:${a.values.row_id}`.localeCompare(`${b.table}:${b.values.row_id}`)));

export const readProjectedRows = async (client: SqlClient, key: SourceKey): Promise<SqlRow[]> => {
  const rows: SqlRow[] = [];
  for (const table of tablesForKey(key)) {
    const result = await client.query(`SELECT * FROM olbia.${table} WHERE source_pk=$1 AND source_sk=$2`, [key.PK, key.SK]);
    rows.push(...result.rows.map((values) => ({ table, values })));
  }
  return rows;
};

// A SQL snapshot plus source reads around the comparison distinguish observed
// lag from same-checkpoint corruption. This isn't an atomic cross-engine snapshot.
export const verifyKeyDetails = async (pool: TransactionPool, readSource: ReadSource, key: SourceKey): Promise<{ status: 'equal' | 'lag' | 'mismatch'; source?: Awaited<ReturnType<ReadSource>> }> =>
  pool.transaction(async (client) => {
    const checkpoint = await client.query('SELECT source_hash, source_item, deleted, transformer_version FROM olbia.projection_state WHERE source_pk=$1 AND source_sk=$2', [key.PK, key.SK]);
    const before = await readSource(key);
    const actual = await readProjectedRows(client, key);
    const after = await readSource(key);
    if (sourceHash(before) !== sourceHash(after)) return { status: 'lag', source: after };
    if (checkpoint.rows[0]?.source_hash !== sourceHash(after)
      || Number(checkpoint.rows[0]?.transformer_version) !== PROJECTION_VERSION) return { status: 'lag', source: after };
    if (sourceHash(checkpoint.rows[0]?.source_item as Awaited<ReturnType<ReadSource>> ?? undefined) !== sourceHash(after)
      || checkpoint.rows[0]?.deleted !== !after) return { status: 'mismatch', source: after };
    return { status: rowSignature(actual) === rowSignature(projectRows(key, after)) ? 'equal' : 'mismatch', source: after };
  });

export const verifyKey = async (pool: TransactionPool, readSource: ReadSource, key: SourceKey): Promise<'equal' | 'lag' | 'mismatch'> =>
  (await verifyKeyDetails(pool, readSource, key)).status;

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_STATEMENTS } from '../../../ledger/test/helpers/migration-schema.js';
import { NATIVE_LEDGER_SCHEMA_STATEMENTS, NATIVE_LEDGER_TABLES, LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../../../ledger/src/dsql/ledger-schema.js';
import { runSqlTransaction } from '../../../ledger/src/dsql/sql-runtime.js';
import { appendLedgerObservation, insertLedgerMovement } from '../../../ledger/src/dsql/ledger-writes.js';
import type { ObservedEventInput } from '../../../ledger/src/observed-events.js';
import type { SqlClient, TransactionPool } from '../../../ledger/src/dsql/projection.js';

export const prepareNativeLedgerFixture = async (client: SqlClient) => {
  for (const statement of NATIVE_LEDGER_SCHEMA_STATEMENTS) await client.query(statement);
  await client.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
};

export const seedNativeMovement = async (pool: TransactionPool, changes: Partial<ObservedEventInput> = {}) => {
  const at = '2026-10-02T12:00:00.123Z';
  const event: ObservedEventInput = { id: randomUUID(), institution: 'santander_mx', eventType: 'card_purchase',
    status: 'accepted', amount: { amountMinor: 10000, currency: 'MXN' }, merchantRaw: 'Original shop',
    occurredAt: at, receivedAt: at, ingestedAt: at, source: { bucket: 'evidence', key: randomUUID(),
      sha256: 'a'.repeat(64), contentType: 'message/rfc822' }, parserVersion: 'original', parseWarnings: [], ...changes };
  await runSqlTransaction(pool, async client => {
    const id = randomUUID();
    await insertLedgerMovement(client, event, id, event.occurredAt ?? event.receivedAt);
    await appendLedgerObservation(client, { id, movementId: event.id, captureSource: 'email',
      observedAt: event.receivedAt, reconciliationAt: event.occurredAt ?? event.receivedAt,
      institution: event.institution, eventType: event.eventType, amount: event.amount, merchantRaw: event.merchantRaw,
      occurredAt: event.occurredAt, account: event.account, source: event.source, parserVersion: event.parserVersion,
      parseWarnings: event.parseWarnings });
  });
  return event.id;
};

export const nativeFixture = async () => {
  const sql = new PGlite();
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  await prepareNativeLedgerFixture(sql);
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  const pool: SqlClient & TransactionPool = { query: (s, v) => sql.query<Record<string, unknown>>(s, v),
    transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) };
  const run = <T>(fn: () => Promise<T>): Promise<T> => runSqlTransaction(pool, fn);
  const reset = async () => {
    await sql.exec(`TRUNCATE ${[...NATIVE_LEDGER_TABLES,'ingestion_retry_attempts', 'projection_state', 'command_receipts', 'merchant_rules',
      'bank_imports', 'bank_import_rows', 'bank_import_candidates'].map(t => `olbia.${t}`).join(',')}`);
    await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  };
  const create = (changes: Partial<ObservedEventInput> = {}) => seedNativeMovement(pool, changes);
  const snapshot = async () => Object.fromEntries(await Promise.all([...NATIVE_LEDGER_TABLES, 'merchant_rules', 'projection_state', 'command_receipts']
    .map(async table => [table, (await sql.query(`SELECT * FROM olbia.${table} ORDER BY 1,2`)).rows])));
  return { sql, pool, run, reset, create, snapshot };
};

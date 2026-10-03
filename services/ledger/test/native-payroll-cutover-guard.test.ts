import { PGlite } from '@electric-sql/pglite';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { OlbiaSqlStore } from '../src/dsql/legacy-document-store.js';
import type { SqlClient } from '../src/dsql/projection.js';

let sql: PGlite, store: OlbiaSqlStore;
const uuid = '11111111-1111-1111-1111-111111111111';
const payslip = { PK: 'USER#owner', SK: `PAYROLL#2026-09#${uuid}`, owner: 'owner', month: '2026-09', uuid,
  entityType: 'cfdi_nomina', ingestedAt: '2026-09-01T12:00:00Z', payload: { uuid, month: '2026-09', fechaPago: '2026-09-01',
    tipoNomina: 'O', totalMinor: 100, totalPercepcionesMinor: 100, totalDeduccionesMinor: 0, totalOtrosPagosMinor: 0, lines: [] } };
const claim = { PK: `DEDUPE#CFDI_NOMINA#${uuid}`, SK: 'CLAIM', owner: 'owner', uuid, month: '2026-09',
  entityType: 'cfdi_nomina_dedupe', claimedAt: payslip.ingestedAt };
const input = (item: { PK: string; SK: string }) => ({ TableName: 'metadata', Key: { PK: item.PK, SK: item.SK } });
beforeAll(async () => {
  sql = new PGlite(); for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
  store = new OlbiaSqlStore({ query: (s,v) => sql.query(s,v),
    transaction: fn => sql.transaction(client => fn(client as unknown as SqlClient)) }, 'metadata');
},30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec('TRUNCATE olbia.projection_state,olbia.payroll,olbia.dedupe_claims,olbia.command_receipts');
  await sql.query('DELETE FROM olbia.schema_migrations WHERE version=12');
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
});
describe('payroll and CFDI-claim cutover guard', () => {
  it('allows normal atomic ingestion before the marker and preserves legacy UUID idempotence', async () => {
    const upload = new TransactWriteCommand({ TransactItems: [claim,payslip].map(Item => ({ Put: {
      TableName: 'metadata',Item,ConditionExpression: 'attribute_not_exists(PK)' } })) });
    await store.send(upload);
    await expect(store.send(upload)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await store.send(new GetCommand(input(payslip)))).Item).toEqual(payslip);
    expect((await sql.query('SELECT * FROM olbia.payroll')).rows).toHaveLength(1);
    expect((await sql.query('SELECT * FROM olbia.dedupe_claims')).rows).toHaveLength(1);
  });
  it('blocks every legacy receipt/claim mutation after copy while keeping evidence readable and other claims operational', async () => {
    for (const item of [claim,payslip]) await store.send(new PutCommand({ TableName: 'metadata',Item: item }));
    const before = (await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk')).rows;
    await sql.query('INSERT INTO olbia.schema_migrations VALUES (12,CURRENT_TIMESTAMP)');
    for (const item of [claim,payslip]) {
      for (const command of [new PutCommand({ TableName: 'metadata',Item: item }),new DeleteCommand(input(item)),
        new UpdateCommand({ ...input(item),UpdateExpression: 'SET #owner=:owner',ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':owner': 'owner' } })]) await expect(store.send(command)).rejects.toMatchObject({ name: 'MigrationPausedException' });
      expect((await store.send(new GetCommand(input(item)))).Item).toEqual(item);
    }
    expect((await sql.query('SELECT * FROM olbia.projection_state ORDER BY source_pk')).rows).toEqual(before);
    const other = { PK: 'DEDUPE#source-email-hash',SK: 'CLAIM',entityType: 'source_dedupe_claim' };
    await store.send(new PutCommand({ TableName: 'metadata',Item: other }));
    expect((await store.send(new GetCommand(input(other)))).Item).toEqual(other);
  });
  it('rolls back earlier writes and receipts when either half of an upload is blocked', async () => {
    await sql.query('INSERT INTO olbia.schema_migrations VALUES (12,CURRENT_TIMESTAMP)');
    for (const item of [claim,payslip]) await expect(store.send(new TransactWriteCommand({ ClientRequestToken: `guard-${item.SK}`,
      TransactItems: [{ Put: { TableName: 'metadata',Item: { PK: 'DEDUPE#ordinary-source',SK: 'CLAIM',entityType: 'source_dedupe_claim' } } },
        { Put: { TableName: 'metadata',Item: item } }] }))).rejects.toMatchObject({ name: 'MigrationPausedException' });
    for (const table of ['projection_state','payroll','dedupe_claims','command_receipts']) expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(0);
  });
  it('restores receipt/claim evidence and marker absence when a shared cutover transaction aborts', async () => {
    for (const item of [claim,payslip]) await store.send(new PutCommand({ TableName: 'metadata',Item: item }));
    await expect(store.transaction(async client => {
      await store.send(new DeleteCommand(input(claim))); await store.send(new DeleteCommand(input(payslip)));
      await client.query('INSERT INTO olbia.schema_migrations VALUES (12,CURRENT_TIMESTAMP)'); throw new Error('Interrupted');
    })).rejects.toThrow('Interrupted');
    for (const item of [claim,payslip]) expect((await store.send(new GetCommand(input(item)))).Item).toEqual(item);
    expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=12')).rows).toHaveLength(0);
  });
});

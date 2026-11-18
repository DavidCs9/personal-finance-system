import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../src/dsql/schema.js';
import { NATIVE_FINANCIAL_PLAN_TABLES } from '../src/dsql/financial-plan-schema.js';
import { smokeNativeFinancialPlans } from '../src/dsql/financial-plan-smoke.js';
import type { SqlClient } from '../src/dsql/projection.js';

it('exercises native financial plan writes and receipts while leaving every financial table unchanged after rollback', async () => {
  const sql = new PGlite();
  try {
    for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
    const rollback = new Error('required verification rollback');
    await expect(sql.transaction(async client => {
      await smokeNativeFinancialPlans(client as unknown as SqlClient, 'owner');
      expect((await client.query('SELECT id FROM olbia.expected_income')).rows).toHaveLength(1);
      expect((await client.query('SELECT id FROM olbia.financial_goals')).rows).toHaveLength(1);
      expect((await client.query('SELECT operation_id FROM olbia.financial_change_receipts')).rows).toHaveLength(1);
      throw rollback;
    })).rejects.toBe(rollback);
    for (const table of NATIVE_FINANCIAL_PLAN_TABLES) expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);
  } finally { await sql.close(); }
}, 30_000);

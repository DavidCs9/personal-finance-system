import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { SCHEMA_STATEMENTS, ensureIncomeScheduleSchema } from '../src/dsql/schema.js';
import { INCOME_SCHEDULE_CHECK, NATIVE_FINANCIAL_PLAN_TABLES } from '../src/dsql/financial-plan-schema.js';
import { readExpectedIncome } from '../src/dsql/financial-plans.js';
import { smokeNativeFinancialPlans } from '../src/dsql/financial-plan-smoke.js';
import type { SqlClient } from '../src/dsql/projection.js';

it('exercises native financial plan writes and receipts while leaving every financial table unchanged after rollback', async () => {
  const sql = new PGlite();
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      const ddl = statement.startsWith('CREATE TABLE IF NOT EXISTS olbia.expected_income (')
        ? statement.replace('payment_rule_1 text, payment_rule_2 text, withhold_partial_months boolean,', '')
          .replace(`CONSTRAINT expected_income_payment_rules_check ${INCOME_SCHEDULE_CHECK},`, '')
        : statement;
      await sql.query(ddl);
    }
    const legacyId = '11111111-2222-4333-8444-555555555555';
    await sql.query(`INSERT INTO olbia.expected_income
      (id,owner,name,amount_mxn_minor,frequency,payment_day_1,start_date,confidence,status,revision,created_at,updated_at)
      VALUES ($1,'legacy','Legacy salary',550,'monthly',31,'2026-11-23','estimated','active',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [legacyId]);
    const client: SqlClient = { query: async (statement, values) => {
      if (statement.startsWith('ALTER TABLE ASYNC')) {
        await sql.query(statement.replace('ALTER TABLE ASYNC', 'ALTER TABLE'));
        return { rows: [{ job_id: 'test-validation' }] };
      }
      return sql.query<Record<string, unknown>>(statement, values);
    } };
    await ensureIncomeScheduleSchema(client);
    await ensureIncomeScheduleSchema(client);
    const original = await readExpectedIncome(client, 'legacy', legacyId);
    expect(original).toMatchObject({ amountMxnMinor: 550, paymentDays: [31], revision: 4 });
    expect(original).not.toHaveProperty('paymentRules');
    const rollback = new Error('required verification rollback');
    await expect(sql.transaction(async client => {
      await smokeNativeFinancialPlans(client as unknown as SqlClient, 'owner');
      expect((await client.query('SELECT id FROM olbia.expected_income')).rows).toHaveLength(2);
      expect((await client.query('SELECT id FROM olbia.financial_goals')).rows).toHaveLength(1);
      expect((await client.query('SELECT id FROM olbia.spending_budgets')).rows).toHaveLength(1);
      expect((await client.query('SELECT operation_id FROM olbia.financial_change_receipts')).rows).toHaveLength(2);
      throw rollback;
    })).rejects.toBe(rollback);
    for (const table of NATIVE_FINANCIAL_PLAN_TABLES.filter(table => table !== 'expected_income')) {
      expect((await sql.query(`SELECT * FROM olbia.${table}`)).rows).toEqual([]);
    }
    expect(await readExpectedIncome(client, 'legacy', legacyId)).toEqual(original);
    expect((await sql.query('SELECT id FROM olbia.expected_income')).rows).toEqual([{ id: legacyId }]);
  } finally { await sql.close(); }
}, 30_000);

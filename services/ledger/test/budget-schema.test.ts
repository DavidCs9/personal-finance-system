import { PGlite } from '@electric-sql/pglite';
import { it, expect } from 'vitest';
import { SCHEMA_STATEMENTS, ensureBudgetSchema } from '../src/dsql/schema.js';
import { smokeNativeFinancialPlans } from '../src/dsql/financial-plan-smoke.js';
import { FINANCIAL_RECEIPT_ENTITY_CHECK, FINANCIAL_WRITE_KIND_CHECK } from '../src/dsql/financial-plan-schema.js';
import type { SqlClient } from '../src/dsql/projection.js';

it('upgrades the deployed P1 receipt checks resumably and accepts budget receipts without weakening old kinds', async () => {
  const sql = new PGlite();
  try {
    // Construct the deployed predecessor, with no budget receipt columns and original checks.
    const oldKindCheck = "CHECK (kind IN ('income','goal','manual_charge'))";
    const oldEntityCheck = `CHECK (
      (kind='income' AND income_id IS NOT NULL AND goal_id IS NULL AND movement_id IS NULL) OR
      (kind='goal' AND goal_id IS NOT NULL AND income_id IS NULL AND movement_id IS NULL) OR
      (kind='manual_charge' AND movement_id IS NOT NULL AND income_id IS NULL AND goal_id IS NULL))`;
    for (const statement of SCHEMA_STATEMENTS) {
      let ddl: string = statement;
      if (ddl.includes('CREATE TABLE IF NOT EXISTS olbia.financial_write_operations')) ddl = ddl
        .replace(`CONSTRAINT financial_write_operations_reconciliation_kind_check ${FINANCIAL_WRITE_KIND_CHECK}`, oldKindCheck);
      if (ddl.includes('CREATE TABLE IF NOT EXISTS olbia.financial_change_receipts')) ddl = ddl
        .replace(`CONSTRAINT financial_change_receipts_reconciliation_kind_check ${FINANCIAL_WRITE_KIND_CHECK}`, oldKindCheck)
        .replace(' budget_id uuid CONSTRAINT financial_receipts_budget_fk REFERENCES olbia.spending_budgets(id),\n    budget_exclusion_id uuid CONSTRAINT financial_receipts_budget_exclusion_fk REFERENCES olbia.budget_exclusions(id),', '')
        .replace(`CONSTRAINT financial_receipts_reconciliation_entity_check ${FINANCIAL_RECEIPT_ENTITY_CHECK}`, oldEntityCheck);
      await sql.query(ddl);
    }
    const oldChecks = (await sql.query<{ conname: string; definition: string }>(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='olbia.financial_change_receipts'::regclass AND contype='c'`)).rows;
    expect(oldChecks.find(c => c.conname === 'financial_change_receipts_check')?.definition).toContain('manual_charge');
    const client: SqlClient = { query: async (statement, values) => {
      if (statement.startsWith('ALTER TABLE ASYNC')) {
        await sql.query(statement.replace('ALTER TABLE ASYNC', 'ALTER TABLE'));
        return { rows: [{ job_id: 'test-validation' }] };
      }
      return sql.query<Record<string, unknown>>(statement, values);
    } };
    await ensureBudgetSchema(client);
    await ensureBudgetSchema(client);
    const currentChecks = (await sql.query<{ conname: string; convalidated: boolean }>(`SELECT conname,convalidated FROM pg_constraint
      WHERE conrelid='olbia.financial_change_receipts'::regclass AND contype='c'`)).rows;
    expect(currentChecks).toContainEqual({ conname: 'financial_receipts_reconciliation_entity_check', convalidated: true });
    expect(currentChecks.some(c => c.conname === 'financial_change_receipts_check')).toBe(false);
    const rollback = new Error('rollback all financial smoke');
    await expect(sql.transaction(async tx => { await smokeNativeFinancialPlans(tx as unknown as SqlClient, 'owner'); throw rollback; })).rejects.toBe(rollback);
    expect((await sql.query('SELECT * FROM olbia.spending_budgets')).rows).toEqual([]);
  } finally { await sql.close(); }
}, 30_000);

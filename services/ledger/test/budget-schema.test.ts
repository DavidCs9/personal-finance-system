import { PGlite } from '@electric-sql/pglite';
import { it, expect } from 'vitest';
import { SCHEMA_STATEMENTS, ensureBudgetSchema, ensureLedgerCreditTypes, ensureManualReconciliationSchema } from '../src/dsql/schema.js';
import { LEDGER_EVENT_TYPE_CHECK, LEDGER_CREDIT_KIND_CHECK, LEDGER_CREDIT_TERMS_CHECK,
  installmentEvidenceOriginCheck, installmentManualObservationCheck, installmentManualObservationFk } from '../src/dsql/ledger-schema.js';
import { smokeNativeFinancialPlans } from '../src/dsql/financial-plan-smoke.js';
import { FINANCIAL_RECEIPT_ENTITY_CHECK, FINANCIAL_WRITE_KIND_CHECK } from '../src/dsql/financial-plan-schema.js';
import type { SqlClient } from '../src/dsql/projection.js';

it('upgrades old receipt and ledger checks resumably while retaining the original financial kinds', async () => {
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
      for (const table of ['ledger_movements', 'ledger_observations']) ddl = ddl.replace(
        `CONSTRAINT ${table}_credit_type_check ${LEDGER_EVENT_TYPE_CHECK}`,
        `CHECK (event_type IN ('card_purchase','card_charge','outgoing_transfer'))`);
      if (ddl.includes('CREATE TABLE IF NOT EXISTS olbia.ledger_credit_details')) ddl = ddl
        .replace(`CONSTRAINT ledger_credit_details_reconciliation_kind_check ${LEDGER_CREDIT_KIND_CHECK}`,
          "CHECK (kind IN ('income','refund','fund_release'))")
        .replace(`CONSTRAINT ledger_credit_details_reconciliation_terms_check ${LEDGER_CREDIT_TERMS_CHECK}`,
          LEDGER_CREDIT_TERMS_CHECK.replace(" OR (kind='card_payment' AND account_kind='credit_card' AND income_type IS NULL)", '').replace(/\s+\)/g, ')'));
      if (ddl.includes('CREATE TABLE IF NOT EXISTS olbia.installment_entries')) ddl = ddl
        .replace(`CONSTRAINT installment_evidence_origin_check ${installmentEvidenceOriginCheck}`,
          "CHECK (evidence_origin IN ('bank_row','ambiguous_bank_row','legacy_backfill'))")
        .replace('    manual_observation_id uuid,\n', '')
        .replace(`    CONSTRAINT installment_manual_observation_check ${installmentManualObservationCheck},\n`, '')
        .replace(`    CONSTRAINT installment_manual_observation_fk ${installmentManualObservationFk},\n`, '');
      if (ddl.includes('CREATE TABLE IF NOT EXISTS olbia.financial_write_operations')) ddl = ddl
        .replace(`CONSTRAINT financial_write_operations_manual_reconciliation_kind_check ${FINANCIAL_WRITE_KIND_CHECK}`, oldKindCheck);
      if (ddl.includes('CREATE TABLE IF NOT EXISTS olbia.financial_change_receipts')) ddl = ddl
        .replace(`CONSTRAINT financial_change_receipts_manual_reconciliation_kind_check ${FINANCIAL_WRITE_KIND_CHECK}`, oldKindCheck)
        .replace(' budget_id uuid CONSTRAINT financial_receipts_budget_fk REFERENCES olbia.spending_budgets(id),\n    budget_exclusion_id uuid CONSTRAINT financial_receipts_budget_exclusion_fk REFERENCES olbia.budget_exclusions(id),', '')
        .replace('    monthly_received_id uuid CONSTRAINT financial_receipts_monthly_received_fk REFERENCES olbia.monthly_received_totals(id),\n', '')
        .replace(`CONSTRAINT financial_receipts_manual_reconciliation_entity_check ${FINANCIAL_RECEIPT_ENTITY_CHECK}`, oldEntityCheck);
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
    await ensureLedgerCreditTypes(client);
    await ensureLedgerCreditTypes(client);
    await ensureManualReconciliationSchema(client);
    await ensureManualReconciliationSchema(client);
    const nativeChecks = (await sql.query<{ conname: string; convalidated: boolean }>(`SELECT conname,convalidated FROM pg_constraint
      WHERE conrelid IN ('olbia.ledger_credit_details'::regclass,'olbia.installment_entries'::regclass)`)).rows;
    expect(nativeChecks).toContainEqual({ conname: 'installment_manual_observation_fk', convalidated: true });
    expect(nativeChecks).toContainEqual({ conname: 'ledger_credit_details_reconciliation_terms_check', convalidated: true });
    expect(nativeChecks.some(c => ['ledger_credit_details_check','ledger_credit_details_kind_check',
      'installment_entries_evidence_origin_check'].includes(c.conname))).toBe(false);
    const currentChecks = (await sql.query<{ conname: string; convalidated: boolean }>(`SELECT conname,convalidated FROM pg_constraint
      WHERE conrelid='olbia.financial_change_receipts'::regclass AND contype='c'`)).rows;
    expect(currentChecks).toContainEqual({ conname: 'financial_receipts_manual_reconciliation_entity_check', convalidated: true });
    expect(currentChecks.some(c => c.conname === 'financial_change_receipts_check')).toBe(false);
    const ledgerChecks = (await sql.query<{ conname: string; definition: string; convalidated: boolean }>(`SELECT conname,pg_get_constraintdef(oid) AS definition,convalidated
      FROM pg_constraint WHERE conrelid IN ('olbia.ledger_movements'::regclass,'olbia.ledger_observations'::regclass)
      AND (conname LIKE '%event_type_check' OR conname LIKE '%credit_type_check') ORDER BY conname`)).rows;
    expect(ledgerChecks).toEqual(['ledger_movements_credit_type_check','ledger_observations_credit_type_check']
      .map(conname => ({ conname, definition: expect.stringContaining('bank_credit'), convalidated: true })));
    const rollback = new Error('rollback all financial smoke');
    await expect(sql.transaction(async tx => { await smokeNativeFinancialPlans(tx as unknown as SqlClient, 'owner'); throw rollback; })).rejects.toBe(rollback);
    expect((await sql.query('SELECT * FROM olbia.spending_budgets')).rows).toEqual([]);
  } finally { await sql.close(); }
}, 30_000);

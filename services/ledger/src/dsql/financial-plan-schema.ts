import { NATIVE_BUDGET_TABLES, NATIVE_BUDGET_SCHEMA_STATEMENTS, nativeBudgetWriteGrants } from './budget-schema.js';
/** Typed current plans; JSON is limited to frozen preview intent and immutable receipts. */
export const NATIVE_FINANCIAL_PLAN_TABLES = ['expected_income', 'financial_goals', 'goal_allocations', 'goal_payments',
  'monthly_received_totals', 'financial_write_operations', 'financial_change_receipts', 'expected_income_month_overrides', ...NATIVE_BUDGET_TABLES] as const;
const money = 'BETWEEN 1 AND 9007199254740991';
export const FINANCIAL_WRITE_KIND_CHECK = "CHECK (kind IN ('income','goal','manual_charge','manual_credit','manual_reconciliation','budget','fixed_reconciliation','msi_reconciliation','monthly_received'))";
export const FINANCIAL_RECEIPT_ENTITY_CHECK = `CHECK (
  (kind='monthly_received') = (monthly_received_id IS NOT NULL) AND (
  (kind='monthly_received' AND income_id IS NULL AND goal_id IS NULL AND movement_id IS NULL AND budget_id IS NULL AND budget_exclusion_id IS NULL) OR
  (kind='income' AND income_id IS NOT NULL AND goal_id IS NULL AND movement_id IS NULL AND budget_id IS NULL AND budget_exclusion_id IS NULL) OR
  (kind='goal' AND goal_id IS NOT NULL AND income_id IS NULL AND movement_id IS NULL AND budget_id IS NULL AND budget_exclusion_id IS NULL) OR
  (kind IN ('manual_charge','manual_credit','manual_reconciliation','fixed_reconciliation','msi_reconciliation') AND movement_id IS NOT NULL
    AND income_id IS NULL AND goal_id IS NULL AND budget_id IS NULL AND budget_exclusion_id IS NULL) OR
  (kind='budget' AND income_id IS NULL AND goal_id IS NULL AND movement_id IS NULL AND
    ((budget_id IS NOT NULL AND budget_exclusion_id IS NULL) OR (budget_id IS NULL AND budget_exclusion_id IS NOT NULL)))))`;
export const INCOME_SCHEDULE_CHECK = `CHECK (
  (payment_rule_1 IS NULL OR (payment_day_1 IS NOT NULL AND
    (payment_rule_1='previous_business_day' OR (payment_rule_1='last_business_day' AND payment_day_1=31))))
  AND (payment_rule_2 IS NULL OR (payment_day_2 IS NOT NULL AND
    (payment_rule_2='previous_business_day' OR (payment_rule_2='last_business_day' AND payment_day_2=31))))
  AND ((payment_rule_1 IS NULL AND payment_rule_2 IS NULL) OR withhold_partial_months IS TRUE)
  AND (frequency<>'one_time' OR withhold_partial_months IS NULL))`;
export const NATIVE_FINANCIAL_PLAN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.expected_income (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200), employer text CHECK (length(trim(employer)) BETWEEN 1 AND 200),
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor ${money}),
    frequency text NOT NULL CHECK (frequency IN ('monthly','semimonthly','one_time')),
    payment_day_1 integer CHECK (payment_day_1 BETWEEN 1 AND 31), payment_day_2 integer CHECK (payment_day_2 BETWEEN 1 AND 31),
    payment_rule_1 text, payment_rule_2 text, withhold_partial_months boolean,
    expected_on date, start_date date NOT NULL, end_date date CHECK (end_date>=start_date),
    confidence text NOT NULL CHECK (confidence IN ('estimated','confirmed')),
    status text NOT NULL CHECK (status IN ('active','archived')), revision integer NOT NULL CHECK (revision>0),
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    CONSTRAINT expected_income_payment_rules_check ${INCOME_SCHEDULE_CHECK},
    CHECK ((frequency='monthly' AND payment_day_1 IS NOT NULL AND payment_day_2 IS NULL AND expected_on IS NULL) OR
      (frequency='semimonthly' AND payment_day_1 IS NOT NULL AND payment_day_2 IS NOT NULL AND payment_day_1<payment_day_2 AND expected_on IS NULL) OR
      (frequency='one_time' AND payment_day_1 IS NULL AND payment_day_2 IS NULL AND expected_on IS NOT NULL AND expected_on>=start_date AND (end_date IS NULL OR expected_on<=end_date))))`,
  `CREATE TABLE IF NOT EXISTS olbia.expected_income_month_overrides (
    income_id uuid NOT NULL REFERENCES olbia.expected_income(id),
    month text NOT NULL CHECK (month ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'),
    payment_on date, amount_mxn_minor bigint CHECK (amount_mxn_minor BETWEEN 0 AND 9007199254740991),
    confidence text NOT NULL CHECK (confidence IN ('estimated','confirmed')),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
    PRIMARY KEY (income_id,month),
    CHECK (payment_on IS NULL OR (
      EXTRACT(YEAR FROM payment_on)=substring(month,1,4)::integer AND
      EXTRACT(MONTH FROM payment_on)=substring(month,6,2)::integer)),
    CHECK (amount_mxn_minor IS NULL OR (amount_mxn_minor=0 AND payment_on IS NULL) OR (amount_mxn_minor>0 AND payment_on IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS olbia.financial_goals (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0), name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    original_budget_mxn_minor bigint NOT NULL CHECK (original_budget_mxn_minor ${money}),
    total_budget_mxn_minor bigint NOT NULL CHECK (total_budget_mxn_minor ${money}), target_date date,
    status text NOT NULL CHECK (status IN ('planned','active','completed','archived')),
    revision integer NOT NULL CHECK (revision>0), created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS olbia.goal_allocations (
    id uuid PRIMARY KEY, goal_id uuid NOT NULL REFERENCES olbia.financial_goals(id),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    allocated_mxn_minor bigint NOT NULL CHECK (allocated_mxn_minor BETWEEN 0 AND 9007199254740991), expected_payment_date date,
    status text NOT NULL CHECK (status IN ('active','archived')), revision integer NOT NULL CHECK (revision>0))`,
  `CREATE TABLE IF NOT EXISTS olbia.goal_payments (
    id uuid PRIMARY KEY, allocation_id uuid NOT NULL REFERENCES olbia.goal_allocations(id),
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor ${money}), payment_date date NOT NULL,
    source text NOT NULL CHECK (source IN ('manual_attestation','linked_ledger_movement')),
    ledger_movement_id uuid UNIQUE REFERENCES olbia.ledger_movements(id),
    status text NOT NULL CHECK (status IN ('active','voided')), revision integer NOT NULL CHECK (revision>0),
    recorded_by text NOT NULL CHECK (length(recorded_by)>0), created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    CHECK ((source='manual_attestation' AND ledger_movement_id IS NULL) OR (source='linked_ledger_movement' AND ledger_movement_id IS NOT NULL)))`,
  ...NATIVE_BUDGET_SCHEMA_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS olbia.monthly_received_totals (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    month text NOT NULL CHECK (month ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'),
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor BETWEEN 0 AND 9007199254740991),
    revision integer NOT NULL CHECK (revision>0), updated_at timestamptz NOT NULL,
    UNIQUE (owner,month))`,
  `CREATE TABLE IF NOT EXISTS olbia.financial_write_operations (
    operation_id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    kind text NOT NULL CONSTRAINT financial_write_operations_manual_reconciliation_kind_check ${FINANCIAL_WRITE_KIND_CHECK}, action text NOT NULL CHECK (length(action)>0),
    entity_id uuid NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
    status text NOT NULL CHECK (status IN ('pending','applied','failed')), failure_code text,
    before_state jsonb, after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state)='object'),
    preview_facts jsonb NOT NULL CHECK (jsonb_typeof(preview_facts)='object'),
    evidence_preconditions jsonb NOT NULL CHECK (jsonb_typeof(evidence_preconditions)='object'),
    CHECK (before_state IS NULL OR jsonb_typeof(before_state)='object'),
    CHECK ((status='failed')=(failure_code IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS olbia.financial_change_receipts (
    operation_id uuid PRIMARY KEY REFERENCES olbia.financial_write_operations(operation_id),
    owner text NOT NULL CHECK (length(owner)>0), kind text NOT NULL CONSTRAINT financial_change_receipts_manual_reconciliation_kind_check ${FINANCIAL_WRITE_KIND_CHECK},
    income_id uuid REFERENCES olbia.expected_income(id), goal_id uuid REFERENCES olbia.financial_goals(id),
    movement_id uuid REFERENCES olbia.ledger_movements(id), budget_id uuid CONSTRAINT financial_receipts_budget_fk REFERENCES olbia.spending_budgets(id),
    budget_exclusion_id uuid CONSTRAINT financial_receipts_budget_exclusion_fk REFERENCES olbia.budget_exclusions(id), applied_at timestamptz NOT NULL,
    monthly_received_id uuid CONSTRAINT financial_receipts_monthly_received_fk REFERENCES olbia.monthly_received_totals(id),
    before_state jsonb, after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state)='object'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
    CHECK (before_state IS NULL OR jsonb_typeof(before_state)='object'),
    CONSTRAINT financial_receipts_manual_reconciliation_entity_check ${FINANCIAL_RECEIPT_ENTITY_CHECK})`,
] as const;
export const nativeFinancialPlanReadGrant = (role: string) =>
  `GRANT SELECT ON ${NATIVE_FINANCIAL_PLAN_TABLES.map(table => `olbia.${table}`).join(',')} TO ${role}`;
export const nativeFinancialPlanWriteGrants = (role: string) => [
  ...nativeBudgetWriteGrants(role),
  `GRANT INSERT ON ${NATIVE_FINANCIAL_PLAN_TABLES.map(table => `olbia.${table}`).join(',')} TO ${role}`,
  `GRANT UPDATE (name,employer,amount_mxn_minor,frequency,payment_day_1,payment_day_2,payment_rule_1,payment_rule_2,withhold_partial_months,expected_on,start_date,end_date,confidence,status,revision,updated_at) ON olbia.expected_income TO ${role}`,
  `GRANT UPDATE (payment_on,amount_mxn_minor,confidence,reason) ON olbia.expected_income_month_overrides TO ${role}`,
  `GRANT DELETE ON olbia.expected_income_month_overrides TO ${role}`,
  `GRANT UPDATE (name,total_budget_mxn_minor,target_date,status,revision,updated_at) ON olbia.financial_goals TO ${role}`,
  `GRANT UPDATE (name,allocated_mxn_minor,expected_payment_date,status,revision) ON olbia.goal_allocations TO ${role}`,
  `GRANT UPDATE (allocation_id,amount_mxn_minor,payment_date,source,ledger_movement_id,status,revision,updated_at) ON olbia.goal_payments TO ${role}`,
  `GRANT UPDATE (amount_mxn_minor,revision,updated_at) ON olbia.monthly_received_totals TO ${role}`,
  `GRANT UPDATE (status,failure_code) ON olbia.financial_write_operations TO ${role}`,
];

export const NATIVE_BUDGET_TABLES = ['spending_budgets', 'budget_allocations', 'budget_exclusions'] as const;
export const NATIVE_BUDGET_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.spending_budgets (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    scope text NOT NULL CHECK (scope IN ('recurring','override')),
    effective_month text NOT NULL CHECK (effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    total_mxn_minor bigint NOT NULL CHECK (total_mxn_minor BETWEEN 0 AND 9007199254740991),
    status text NOT NULL CHECK (status IN ('active','archived')), revision integer NOT NULL CHECK (revision>0),
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE (owner,scope,effective_month))`,
  `CREATE TABLE IF NOT EXISTS olbia.budget_allocations (
    budget_id uuid NOT NULL REFERENCES olbia.spending_budgets(id), category_id text NOT NULL REFERENCES olbia.spend_categories(id),
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor BETWEEN 0 AND 9007199254740991), PRIMARY KEY (budget_id,category_id))`,
  `CREATE TABLE IF NOT EXISTS olbia.budget_exclusions (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    status text NOT NULL CHECK (status IN ('active','archived')), revision integer NOT NULL CHECK (revision>0),
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE (owner,month,movement_id))`,
] as const;
export const nativeBudgetReadGrant = (role: string) => `GRANT SELECT ON ${NATIVE_BUDGET_TABLES.map(t => `olbia.${t}`).join(',')} TO ${role}`;
export const nativeBudgetWriteGrants = (role: string) => [
  `GRANT INSERT ON ${NATIVE_BUDGET_TABLES.map(t => `olbia.${t}`).join(',')} TO ${role}`,
  `GRANT UPDATE (total_mxn_minor,status,revision,updated_at) ON olbia.spending_budgets TO ${role}`,
  `GRANT DELETE ON olbia.budget_allocations TO ${role}`,
  `GRANT UPDATE (reason,status,revision,updated_at) ON olbia.budget_exclusions TO ${role}`,
];

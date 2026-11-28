export const FIXED_EXPENSE_VERSION_STATEMENT = `CREATE TABLE IF NOT EXISTS olbia.fixed_expense_versions (
  operation_id uuid PRIMARY KEY REFERENCES olbia.financial_write_operations(operation_id),
  owner text NOT NULL CHECK (length(owner)>0),
  payment_id text NOT NULL CHECK (length(payment_id) BETWEEN 1 AND 128),
  effective_month text NOT NULL CHECK (effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  scope text NOT NULL CHECK (scope IN ('recurring','month')),
  status text NOT NULL CHECK (status IN ('active','archived','inherit')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor BETWEEN 1 AND 9007199254740991),
  due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  revision integer NOT NULL CHECK (revision>0),
  UNIQUE (owner,payment_id,scope,effective_month,revision),
  CHECK (status<>'inherit' OR scope='month'))`;

export const FIXED_EXPENSE_OCCURRENCE_CHECK = `CHECK (
  (scheduled_name IS NULL AND scheduled_amount_minor IS NULL AND scheduled_due_day IS NULL)
  OR (scheduled_name IS NOT NULL AND length(trim(scheduled_name)) BETWEEN 1 AND 100
    AND scheduled_amount_minor IS NOT NULL AND scheduled_amount_minor BETWEEN 1 AND 9007199254740991
    AND scheduled_due_day IS NOT NULL AND scheduled_due_day BETWEEN 1 AND 31))`;

export const FIXED_EXPENSE_PAYMENT_ORDER_CHECK = `CHECK (
  (occurrence_only IS TRUE AND sort_order>=100) OR
  (occurrence_only IS NOT TRUE AND sort_order BETWEEN 0 AND 99))`;

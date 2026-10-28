/** Current monthly links and append-only financial decisions; no inferred matches. */
export const NATIVE_PLANNING_TABLES = ['planned_payment_charges', 'planned_payment_charge_revisions'] as const;

export const NATIVE_PLANNING_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.planned_payment_charges (
    month text NOT NULL, payment_id text NOT NULL,
    movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    linked_at timestamptz NOT NULL, linked_by text NOT NULL CHECK (length(linked_by)>0),
    PRIMARY KEY (month,payment_id),
    CONSTRAINT planned_payment_charges_movement_key UNIQUE (movement_id),
    CONSTRAINT planned_payment_charges_payment_fk FOREIGN KEY (month,payment_id)
      REFERENCES olbia.planned_payments(month,id))`,
  `CREATE TABLE IF NOT EXISTS olbia.planned_payment_charge_revisions (
    id uuid PRIMARY KEY, month text NOT NULL REFERENCES olbia.month_plans(month),
    payment_id text NOT NULL CHECK (length(payment_id) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL, changed_by text NOT NULL CHECK (length(changed_by)>0),
    reason text NOT NULL CHECK (reason IN ('link','unlink','payment_changed','payment_removed')),
    previous_movement_id uuid REFERENCES olbia.ledger_movements(id),
    next_movement_id uuid REFERENCES olbia.ledger_movements(id),
    payment_snapshot jsonb NOT NULL CHECK (jsonb_typeof(payment_snapshot)='object'),
    CHECK (previous_movement_id IS DISTINCT FROM next_movement_id))`,
] as const;

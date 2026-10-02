/** Native financial authority. Activation is deliberately separate from schema preparation. */
export const NATIVE_LEDGER_TABLES = [
  'ledger_movements', 'ledger_observations', 'ledger_movement_warnings', 'ledger_observation_warnings',
  'ledger_tags', 'ledger_bulk_operations', 'ledger_bulk_members', 'ledger_revisions',
  'installment_plans', 'installment_entries', 'installment_evidence_candidates', 'source_claims',
] as const;

const safeMoney = 'BETWEEN 0 AND 9007199254740991';
const positiveMoney = 'BETWEEN 1 AND 9007199254740991';
const captureKinds = "('email','apple_pay_shortcut','manual','santander_csv','amex_statement','santander_statement')";
const accountColumns = `account_present boolean NOT NULL,
  account_id text, account_name text, account_institution text, account_last_four text,
  CHECK (account_present OR (account_id IS NULL AND account_name IS NULL AND
    account_institution IS NULL AND account_last_four IS NULL))`;

export const NATIVE_LEDGER_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.ledger_movements (
    id uuid PRIMARY KEY, primary_observation_id uuid NOT NULL,
    institution text NOT NULL CHECK (length(institution)>0),
    event_type text NOT NULL CHECK (event_type IN ('card_purchase','card_charge','outgoing_transfer')),
    status text NOT NULL CHECK (status IN ('accepted','needs_review','rejected','deferred_msi','pending_foreign')),
    amount_minor bigint NOT NULL CHECK (amount_minor ${safeMoney}),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    merchant_raw text NOT NULL, occurred_at timestamptz,
    received_at timestamptz NOT NULL, ingested_at timestamptz NOT NULL,
    reconciliation_at timestamptz NOT NULL, reconciled_at timestamptz,
    ${accountColumns},
    category_id text REFERENCES olbia.spend_categories(id),
    personal_amount_minor bigint CHECK (personal_amount_minor ${safeMoney} AND personal_amount_minor<=amount_minor),
    bank_transaction_id text, source_message_id text,
    counterparty text, tracking_key text, folio text, reference text, transfer_type text,
    counterparty_institution text, counterparty_account_last_four text,
    billing_period text, payment_method_last_four text,
    CHECK (status<>'pending_foreign' OR currency='USD'),
    CHECK (status<>'pending_foreign' OR personal_amount_minor IS NULL))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_observations (
    id uuid PRIMARY KEY, movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    position integer NOT NULL CHECK (position>=0),
    capture_source text NOT NULL CHECK (capture_source IN ${captureKinds}),
    observed_at timestamptz NOT NULL, reconciliation_at timestamptz NOT NULL,
    institution text NOT NULL CHECK (length(institution)>0),
    event_type text NOT NULL CHECK (event_type IN ('card_purchase','card_charge','outgoing_transfer')),
    amount_minor bigint NOT NULL CHECK (amount_minor ${safeMoney}),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    merchant_raw text NOT NULL, occurred_at timestamptz,
    ${accountColumns},
    parser_version text NOT NULL CHECK (length(parser_version)>0),
    bank_transaction_id text, csv_row_number integer CHECK (csv_row_number>0), note text,
    evidence_bucket text, evidence_key text, evidence_sha256 text CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
    evidence_content_type text, source_kind text,
    source_metadata jsonb NOT NULL CHECK (jsonb_typeof(source_metadata)='object'),
    CONSTRAINT ledger_observations_movement_identity_key UNIQUE (movement_id,id),
    CONSTRAINT ledger_observations_position_key UNIQUE (movement_id,position),
    CHECK ((evidence_bucket IS NULL)=(evidence_key IS NULL) AND
      (evidence_bucket IS NULL)=(evidence_sha256 IS NULL) AND
      (evidence_bucket IS NULL)=(evidence_content_type IS NULL)))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_movement_warnings (
    movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    position integer NOT NULL CHECK (position>=0), message text NOT NULL,
    PRIMARY KEY (movement_id,position))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_observation_warnings (
    observation_id uuid NOT NULL REFERENCES olbia.ledger_observations(id),
    position integer NOT NULL CHECK (position>=0), message text NOT NULL,
    PRIMARY KEY (observation_id,position))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_tags (
    movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    position integer NOT NULL CHECK (position>=0), tag text NOT NULL CHECK (length(tag)>0),
    PRIMARY KEY (movement_id,position), CONSTRAINT ledger_tags_value_key UNIQUE (movement_id,tag))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_bulk_operations (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (length(owner)>0),
    status text NOT NULL CHECK (status IN ('pending','applied','undone')),
    created_at timestamptz NOT NULL, expires_at bigint NOT NULL CHECK (expires_at>=0),
    applied_at timestamptz, undone_at timestamptz,
    selection_assertion jsonb NOT NULL CHECK (jsonb_typeof(selection_assertion)='object'),
    change_assertion jsonb NOT NULL CHECK (jsonb_typeof(change_assertion)='object'),
    CHECK ((status='pending' AND applied_at IS NULL AND undone_at IS NULL) OR
      (status='applied' AND applied_at IS NOT NULL AND undone_at IS NULL) OR
      (status='undone' AND applied_at IS NOT NULL AND undone_at IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_bulk_members (
    operation_id uuid NOT NULL REFERENCES olbia.ledger_bulk_operations(id),
    position integer NOT NULL CHECK (position BETWEEN 0 AND 48),
    movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    merchant_assertion text NOT NULL, occurred_at_assertion timestamptz,
    status_assertion text NOT NULL CHECK (status_assertion='accepted'),
    amount_minor_assertion bigint NOT NULL CHECK (amount_minor_assertion ${safeMoney}),
    previous_tags jsonb NOT NULL CHECK (jsonb_typeof(previous_tags)='array'),
    next_tags jsonb NOT NULL CHECK (jsonb_typeof(next_tags)='array'),
    previous_category_id text, next_category_id text,
    PRIMARY KEY (operation_id,position),
    CONSTRAINT ledger_bulk_members_movement_key UNIQUE (operation_id,movement_id))`,
  `CREATE TABLE IF NOT EXISTS olbia.ledger_revisions (
    id text PRIMARY KEY CHECK (length(id)>0),
    movement_id uuid NOT NULL REFERENCES olbia.ledger_movements(id),
    created_at timestamptz NOT NULL, changed_by text NOT NULL, reason text,
    operation_id uuid REFERENCES olbia.ledger_bulk_operations(id), source text,
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes)='object'))`,
  `CREATE TABLE IF NOT EXISTS olbia.installment_plans (
    movement_id uuid PRIMARY KEY REFERENCES olbia.ledger_movements(id),
    months integer NOT NULL CHECK (months BETWEEN 1 AND 48),
    principal_minor bigint NOT NULL CHECK (principal_minor ${positiveMoney}),
    cuota_minor bigint NOT NULL CHECK (cuota_minor ${positiveMoney}),
    origin text NOT NULL CHECK (origin IN ('amex_auto','manual','statement_unplanned')),
    status text NOT NULL CHECK (status IN ('active','completed','cancelled')),
    needs_schedule_completion boolean)`,
  `CREATE TABLE IF NOT EXISTS olbia.installment_entries (
    movement_id uuid NOT NULL REFERENCES olbia.installment_plans(movement_id),
    installment_index integer NOT NULL CHECK (installment_index BETWEEN 1 AND 48),
    month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    amount_minor bigint NOT NULL CHECK (amount_minor ${positiveMoney}),
    status text NOT NULL CHECK (status IN ('committed','spent','cancelled')),
    occurred_on date, confirmed_at timestamptz,
    evidence_identity text, evidence_origin text CHECK (evidence_origin IN ('bank_row','ambiguous_bank_row','legacy_backfill')),
    evidence_import_kind text, evidence_content_sha256 text, evidence_row_position integer,
    PRIMARY KEY (movement_id,installment_index),
    CONSTRAINT installment_entries_month_key UNIQUE (movement_id,month),
    CONSTRAINT installment_entries_evidence_fk FOREIGN KEY
      (evidence_import_kind,evidence_content_sha256,evidence_row_position)
      REFERENCES olbia.bank_import_rows(kind,content_sha256,position) MATCH FULL,
    CHECK ((evidence_identity IS NULL)=(evidence_origin IS NULL)),
    CHECK (evidence_identity IS NULL OR confirmed_at IS NOT NULL),
    CHECK ((evidence_origin='bank_row' AND evidence_import_kind IS NOT NULL AND
      evidence_content_sha256 IS NOT NULL AND evidence_row_position IS NOT NULL) OR
      (evidence_origin IS DISTINCT FROM 'bank_row' AND evidence_import_kind IS NULL AND
        evidence_content_sha256 IS NULL AND evidence_row_position IS NULL)))`,
  `CREATE TABLE IF NOT EXISTS olbia.installment_evidence_candidates (
    movement_id uuid NOT NULL, installment_index integer NOT NULL,
    import_kind text NOT NULL, content_sha256 text NOT NULL, row_position integer NOT NULL,
    PRIMARY KEY (movement_id,installment_index,import_kind,content_sha256,row_position),
    FOREIGN KEY (movement_id,installment_index)
      REFERENCES olbia.installment_entries(movement_id,installment_index),
    FOREIGN KEY (import_kind,content_sha256,row_position)
      REFERENCES olbia.bank_import_rows(kind,content_sha256,position))`,
  `CREATE TABLE IF NOT EXISTS olbia.source_claims (
    capture_source text NOT NULL CHECK (capture_source IN ${captureKinds}),
    token text NOT NULL CHECK (length(token)>0), created_at timestamptz NOT NULL,
    owner text, row_identity text, fingerprint text, reconciled boolean,
    outcome text NOT NULL CHECK (outcome IN ('linked','suppressed','unresolved_suppression','historical_missing')),
    movement_id uuid REFERENCES olbia.ledger_movements(id), observation_id uuid,
    historical_target_id uuid,
    PRIMARY KEY (capture_source,token),
    CONSTRAINT source_claims_observation_fk FOREIGN KEY (movement_id,observation_id)
      REFERENCES olbia.ledger_observations(movement_id,id),
    CHECK (observation_id IS NULL OR movement_id IS NOT NULL),
    CHECK ((outcome='linked' AND movement_id IS NOT NULL AND historical_target_id IS NULL) OR
      (outcome='historical_missing' AND movement_id IS NULL AND observation_id IS NULL AND historical_target_id IS NOT NULL) OR
      (outcome IN ('suppressed','unresolved_suppression') AND movement_id IS NULL AND
        observation_id IS NULL AND historical_target_id IS NULL)),
    CHECK (outcome NOT IN ('suppressed','unresolved_suppression') OR capture_source='email'))`,
] as const;

/** Install after both tables exist; native deferred ownership permits atomic creation of the pair. */
export const LEDGER_PRIMARY_OBSERVATION_CONSTRAINT = `FOREIGN KEY (id,primary_observation_id)
  REFERENCES olbia.ledger_observations(movement_id,id) DEFERRABLE INITIALLY DEFERRED`;

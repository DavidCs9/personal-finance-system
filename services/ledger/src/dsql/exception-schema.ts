/** Native review evidence and independently identified retry attempts; originals stay frozen. */
export const NATIVE_EXCEPTION_TABLES = ['ingestion_review_exceptions','ingestion_review_claims','ingestion_retry_attempts'] as const;
export const NATIVE_EXCEPTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.ingestion_review_exceptions (
    id uuid PRIMARY KEY, received_at timestamptz NOT NULL,
    institution text CHECK (institution IS NULL OR length(institution)>0),
    reason text NOT NULL CHECK (reason IN ('unsupported_source','parser_failed','missing_required_data')),
    details text NOT NULL,
    source_bucket text NOT NULL CHECK (length(source_bucket)>0), source_key text NOT NULL CHECK (length(source_key)>0),
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    source_content_type text NOT NULL CHECK (source_content_type='message/rfc822'),
    source_token text NOT NULL CHECK (source_token ~ '^[a-f0-9]{64}$'),
    discarded_at timestamptz, discarded_by text CHECK (discarded_by IS NULL OR length(discarded_by)>0),
    expires_at timestamptz,
    CONSTRAINT ingestion_review_discard_pair CHECK ((discarded_at IS NULL)=(discarded_by IS NULL)),
    CONSTRAINT ingestion_review_claim_identity UNIQUE (id,source_token,reason))`,
  `CREATE TABLE IF NOT EXISTS olbia.ingestion_review_claims (
    source_token text NOT NULL CHECK (source_token ~ '^[a-f0-9]{64}$'),
    extractor_version text NOT NULL CHECK (length(extractor_version)>0), reason text NOT NULL,
    exception_id uuid NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz,
    PRIMARY KEY (source_token,extractor_version,reason),
    CONSTRAINT ingestion_review_claim_parent FOREIGN KEY (exception_id,source_token,reason)
      REFERENCES olbia.ingestion_review_exceptions(id,source_token,reason))`,
  `CREATE TABLE IF NOT EXISTS olbia.ingestion_retry_attempts (
    exception_id uuid NOT NULL REFERENCES olbia.ingestion_review_exceptions(id),
    requested_at timestamptz NOT NULL, requested_by text NOT NULL CHECK (length(requested_by)>0),
    request_id uuid UNIQUE,
    job_source_sha256 text CHECK (job_source_sha256 IS NULL OR job_source_sha256 ~ '^[a-f0-9]{64}$'),
    job_source_content_type text CHECK (job_source_content_type IS NULL OR job_source_content_type='message/rfc822'),
    job_source_message_id text,
    dispatched_at timestamptz, completed_at timestamptz, failed_at timestamptz, failure_details text,
    movement_id uuid REFERENCES olbia.ledger_movements(id), expires_at timestamptz,
    PRIMARY KEY (exception_id,requested_at),
    CONSTRAINT ingestion_retry_source_pair CHECK ((job_source_sha256 IS NULL)=(job_source_content_type IS NULL)),
    CONSTRAINT ingestion_retry_dispatch_order CHECK (dispatched_at IS NULL OR dispatched_at>=requested_at),
    CONSTRAINT ingestion_retry_outcome CHECK (
      (completed_at IS NULL)=(movement_id IS NULL) AND (failed_at IS NULL)=(failure_details IS NULL) AND
      (completed_at IS NULL OR completed_at>=requested_at) AND (failed_at IS NULL OR failed_at>=requested_at)))`,
] as const;
export const nativeExceptionReadGrant=(role:string)=>`GRANT SELECT ON ${NATIVE_EXCEPTION_TABLES.map(t=>`olbia.${t}`).join(',')} TO ${role}`;
export const nativeExceptionWriteGrants=(role:string)=>[
  `GRANT INSERT ON ${NATIVE_EXCEPTION_TABLES.map(t=>`olbia.${t}`).join(',')} TO ${role}`,
  `GRANT UPDATE (discarded_at,discarded_by) ON olbia.ingestion_review_exceptions TO ${role}`,
  `GRANT UPDATE (dispatched_at,completed_at,failed_at,failure_details,movement_id) ON olbia.ingestion_retry_attempts TO ${role}`,
  `GRANT DELETE ON olbia.ingestion_review_claims TO ${role}`,
];

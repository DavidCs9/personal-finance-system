/** David's immutable monthly email evidence and separate provider acceptance. */
export const NATIVE_DELIVERY_TABLES = ['monthly_email_preparations','monthly_email_receipts'] as const;
export const nativeDeliveryReadGrant = (role:string) =>
  `GRANT SELECT ON olbia.monthly_email_preparations,olbia.monthly_email_receipts TO ${role}`;
export const nativeDeliveryWriteGrant = (role:string) =>
  `GRANT INSERT ON olbia.monthly_email_preparations,olbia.monthly_email_receipts TO ${role}`;
export const NATIVE_DELIVERY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.monthly_email_preparations (
    delivery_kind text NOT NULL CHECK (delivery_kind IN ('monthly_close','month_end_reminder')),
    month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    owner text NOT NULL CHECK (length(owner)>0), prepared_at timestamptz NOT NULL,
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    email_subject text NOT NULL, email_html text NOT NULL, email_text text NOT NULL,
    report_facts jsonb CHECK (jsonb_typeof(report_facts)='object'),
    report_analysis jsonb CHECK (jsonb_typeof(report_analysis)='object'),
    analysis_version text CHECK (length(analysis_version)>0),
    analysis_source text CHECK (analysis_source IN ('bedrock','fallback')),
    analysis_error_name text, as_of_day date,
    PRIMARY KEY (delivery_kind,month),
    CONSTRAINT monthly_email_preparation_variant_check CHECK (
      (delivery_kind='monthly_close' AND report_facts IS NOT NULL AND report_analysis IS NOT NULL
        AND analysis_version IS NOT NULL AND analysis_source IS NOT NULL AND as_of_day IS NULL)
      OR (delivery_kind='month_end_reminder' AND report_facts IS NULL AND report_analysis IS NULL
        AND analysis_version IS NULL AND analysis_source IS NULL AND analysis_error_name IS NULL
        AND as_of_day IS NOT NULL AND to_char(as_of_day,'YYYY-MM')=month)))`,
  `CREATE TABLE IF NOT EXISTS olbia.monthly_email_receipts (
    delivery_kind text NOT NULL, month text NOT NULL, sent_at timestamptz NOT NULL,
    provider_message_id text NOT NULL CHECK (length(provider_message_id)>0),
    PRIMARY KEY (delivery_kind,month),
    CONSTRAINT monthly_email_receipt_preparation_fk FOREIGN KEY (delivery_kind,month)
      REFERENCES olbia.monthly_email_preparations(delivery_kind,month))`,
] as const;

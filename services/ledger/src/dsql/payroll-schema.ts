/** An owner-confirmed, immutable end to an employer's payroll and savings cycle. */
export const PAYROLL_CLOSURES_SCHEMA = `CREATE TABLE IF NOT EXISTS olbia.payroll_closures (
  owner text NOT NULL CHECK (length(owner)>0),
  employer_key text NOT NULL CHECK (length(employer_key)>0),
  source_payslip_uuid uuid NOT NULL REFERENCES olbia.payslips(uuid),
  ended_on date NOT NULL,
  fund_paid_on date NOT NULL CHECK (fund_paid_on>=ended_on),
  fund_paid_mxn_minor bigint NOT NULL CHECK (fund_paid_mxn_minor BETWEEN 1 AND 9007199254740991),
  recorded_at timestamptz NOT NULL,
  evidence_bucket text NOT NULL CHECK (length(evidence_bucket)>0),
  evidence_key text NOT NULL CHECK (length(evidence_key)>0),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (owner,employer_key))`;

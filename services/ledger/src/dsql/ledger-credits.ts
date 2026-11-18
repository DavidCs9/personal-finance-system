import type { BankCredit } from '@finance/domain';
import { reserveLedgerMutations } from './ledger-budget.js';
import type { SqlClient } from './projection.js';

const selection = `SELECT m.id::text,m.institution,m.account_last_four,m.amount_minor,m.currency,m.merchant_raw,m.bank_transaction_id,
    c.posted_on::text,c.kind,c.account_kind,c.income_type,c.fund_employer_key
  FROM olbia.ledger_credit_details c JOIN olbia.ledger_movements m ON m.id=c.movement_id
  JOIN olbia.source_claims s ON s.movement_id=m.id AND s.observation_id=m.primary_observation_id AND s.capture_source='manual'
  LEFT JOIN olbia.payroll_closures f ON f.owner=c.fund_owner AND f.employer_key=c.fund_employer_key
  WHERE s.owner=$1 AND m.event_type='bank_credit' AND m.status='accepted'`;

const creditFromRow = (row: Record<string, unknown>): BankCredit => ({
  movementId: String(row.id), institution: row.institution as BankCredit['institution'],
  accountLastFour: String(row.account_last_four), amountMinor: Number(row.amount_minor), currency: 'MXN',
  postedOn: String(row.posted_on), description: String(row.merchant_raw), evidenceReference: String(row.bank_transaction_id),
  creditType: row.kind as BankCredit['creditType'], accountKind: row.account_kind as BankCredit['accountKind'],
  incomeType: row.income_type as BankCredit['incomeType'],
  fundEmployerKey: row.fund_employer_key as string | null,
});

export const readBankCredit = async (client: SqlClient, owner: string, movementId: string): Promise<BankCredit | null> => {
  const row = (await client.query(`${selection} AND m.id=$2::uuid`, [owner, movementId])).rows[0];
  return row ? creditFromRow(row) : null;
};

export const readBankCreditsForMonth = async (client: SqlClient, owner: string, startOn: string, endOn: string): Promise<BankCredit[]> =>
  (await client.query(`${selection} AND (c.posted_on BETWEEN $2::date AND $3::date
      OR f.fund_paid_on BETWEEN $2::date AND $3::date) ORDER BY c.posted_on,c.movement_id`,
    [owner, startOn, endOn])).rows.map(creditFromRow);

export const readFundCreditTarget = async (client: SqlClient, owner: string, employerKey: string) => {
  const row = (await client.query(`SELECT f.ended_on::text AS ended_on,f.fund_paid_on::text AS fund_paid_on,
    f.fund_paid_mxn_minor,c.movement_id::text AS movement_id
    FROM olbia.payroll_closures f LEFT JOIN olbia.ledger_credit_details c
      ON c.fund_owner=f.owner AND c.fund_employer_key=f.employer_key
    WHERE f.owner=$1 AND f.employer_key=$2`, [owner, employerKey])).rows[0];
  return row ? { endedOn: String(row.ended_on), declaredPostedOn: String(row.fund_paid_on),
    declaredAmountMinor: Number(row.fund_paid_mxn_minor), movementId: row.movement_id as string | null } : null;
};

export const insertBankCreditDetails = async (client: SqlClient, owner: string, credit: BankCredit): Promise<void> => {
  reserveLedgerMutations(1);
  await client.query(`INSERT INTO olbia.ledger_credit_details
    (movement_id,posted_on,kind,account_kind,income_type,fund_owner,fund_employer_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [credit.movementId, credit.postedOn, credit.creditType, credit.accountKind, credit.incomeType,
      credit.fundEmployerKey ? owner : null, credit.fundEmployerKey]);
};

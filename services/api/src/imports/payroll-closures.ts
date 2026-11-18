import type { PayrollClosure } from '@finance/domain';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';

export const readPayrollClosures = async (owner: string, client: ReadSqlClient = readerPool()): Promise<readonly PayrollClosure[]> => {
  const result = await client.query(`SELECT p.employer_name, c.ended_on::text, c.fund_paid_on::text, c.fund_paid_mxn_minor
    FROM olbia.payroll_closures c JOIN olbia.payslips p ON p.uuid=c.source_payslip_uuid AND p.owner=c.owner
    WHERE c.owner=$1 ORDER BY c.fund_paid_on,c.employer_key`, [owner]);
  return result.rows.map(row => ({
    employerName: String(row.employer_name),
    endedOn: String(row.ended_on),
    fundPaidOn: String(row.fund_paid_on),
    fundPaidMinor: Number(row.fund_paid_mxn_minor),
  }));
};

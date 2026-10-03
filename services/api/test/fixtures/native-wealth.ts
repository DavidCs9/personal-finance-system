import { WEALTH_ACCOUNTS } from '@finance/domain';
import { NATIVE_WEALTH_SCHEMA_STATEMENTS } from '../../../ledger/src/dsql/wealth-schema.js';
import type { SqlClient } from '../../../ledger/src/dsql/projection.js';

export const prepareNativeWealthFixture = async (client: SqlClient) => {
  for (const statement of NATIVE_WEALTH_SCHEMA_STATEMENTS) await client.query(statement);
  for (const [position, account] of WEALTH_ACCOUNTS.filter(a => a.sync !== 'derived').entries()) {
    await client.query(`INSERT INTO olbia.asset_accounts (id,name,institution,role,sync,position)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
    [account.id, account.name, account.institution, account.role, account.sync, position]);
  }
};

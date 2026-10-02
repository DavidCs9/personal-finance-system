import { applicationStoreClient, sqlStoreEnabled } from '@finance/ledger/dsql-store';
import type { ReadSqlClient } from '../events/sql-reads.js';

/** Staged before native capture activation; older bundles cannot serve frozen balances. */
export const assertLegacyWealthReadAvailable = async (client?: ReadSqlClient): Promise<void> => {
  if (!client && !sqlStoreEnabled()) return;
  if ((await (client ?? applicationStoreClient()).query('SELECT version FROM olbia.schema_migrations WHERE version=15')).rows.length)
    throw Object.assign(new Error('Olbia está en mantenimiento. Intenta de nuevo más tarde.'), { name: 'MigrationPausedException' });
};

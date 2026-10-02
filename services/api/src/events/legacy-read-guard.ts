import { applicationStoreClient, sqlStoreEnabled } from '@finance/ledger/dsql-store';
import type { ReadSqlClient } from './sql-reads.js';

/** Staged before native activation: old bundles must never serve frozen facts as current finances. */
export const assertLegacyLedgerReadAvailable = async (client?: ReadSqlClient): Promise<void> => {
  if (!client && !sqlStoreEnabled()) return;
  if ((await (client ?? applicationStoreClient()).query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows.length)
    throw Object.assign(new Error('Los movimientos se están migrando. Intenta de nuevo en un momento.'), {name:'MigrationPausedException'});
};

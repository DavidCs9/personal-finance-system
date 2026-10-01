import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
export const createPool = (user = 'olbia_projector', timeouts: { connectionTimeoutMillis?: number; queryTimeoutMillis?: number } = {}): AuroraDSQLPool => new AuroraDSQLPool({
  host: required('DSQL_ENDPOINT'), user, database: 'postgres', max: 2,
  ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: timeouts.connectionTimeoutMillis ?? 10_000,
  idleTimeoutMillis: 10_000, maxLifetimeSeconds: 300, query_timeout: timeouts.queryTimeoutMillis ?? 20_000,
  retry: { maxRetries: 4, baseDelayMs: 25, maxDelayMs: 100 },
  // Driver errors can contain parameter values. Native Lambda/ESM metrics expose failures.
  logger: { warn: () => {}, error: () => {} },
});

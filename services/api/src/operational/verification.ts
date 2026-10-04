import { verifyNativeExceptions } from '../exceptions/verification.js';
import { verifyNativeConversationMetadata } from '../agent/thread-verification.js';
import { verifyNativeMonthlyDeliveries } from '../reports/delivery-verification.js';
import { currentSqlClient } from '@finance/ledger/sql-runtime';
import { createPool } from '@finance/ledger/dsql-connection';
import { type ReadSqlClient } from '../events/sql-reads.js';
import { verifyNativePushSubscriptions } from '../push/read-verification.js';
import { verifyNativeImports } from '../imports/read-verification.js';

let verifierPool: ReturnType<typeof createPool> | undefined;
export const operationalVerificationPool = (): ReadSqlClient => currentSqlClient() ?? (verifierPool ??= createPool('olbia_operational_verifier', { connectionTimeoutMillis: 1500, queryTimeoutMillis: 3000 }));
/** Current native workflows and original source evidence; no migration-copy dependency. */
export const verifyOperationalReads = async (owner: string, now: Date, client?: ReadSqlClient) => {
  const providedClient = client; client ??= operationalVerificationPool();
  const started = Date.now();
  const imports = await verifyNativeImports(owner, client);
  const push = await verifyNativePushSubscriptions(owner, providedClient);
  const deliveries = await verifyNativeMonthlyDeliveries(owner, providedClient);
  const exceptions = await verifyNativeExceptions(now, providedClient);
  const threads = await verifyNativeConversationMetadata(owner, now, providedClient);
  const mismatches = imports.mismatches + push.mismatches + deliveries.mismatches + exceptions.mismatches + threads.mismatches;
  return { mode: 'native-sql', imports, push, deliveries, threads, exceptions, mismatches, elapsedMs: Date.now() - started };
};

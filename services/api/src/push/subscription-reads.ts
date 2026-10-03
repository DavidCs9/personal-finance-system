import { readNativePushMetadata } from '@finance/ledger/native-push';
import { readerPool, withLedgerReadSnapshot } from '../events/sql-reads.js';

/** Product SQL role reads metadata only; no endpoint/key fields or frozen source fallback. */
export const listPublicPushSubscriptions = async (owner: string) => {
  try { return await withLedgerReadSnapshot(() => readNativePushMetadata(readerPool(), owner)); }
  catch { throw Object.assign(new Error('Olbia storage is unavailable.'), {name:'StorageUnavailableException'}); }
};

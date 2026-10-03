import type { JsonObject } from '../http/response.js';
/** Isolated historical inventory oracles; product exception operations use native SQL. */
export const isRetainedLive = (item: JsonObject, at: Date): boolean =>
  typeof item.expiresAt !== 'number' || item.expiresAt > Math.floor(at.getTime() / 1000);
export const publicExceptions = (items: readonly JsonObject[], at: Date, preserveOrder = false): JsonObject[] => (preserveOrder ? [...items] : [...items]
  .sort((a, b) => Buffer.compare(Buffer.from(String(b.GSI1SK)), Buffer.from(String(a.GSI1SK)))
    || Buffer.compare(Buffer.from(`${b.PK}\0${b.SK}`), Buffer.from(`${a.PK}\0${a.SK}`))))
  // Existing query Limit=100 is evaluated BEFORE hiding discarded/completed exceptions.
  .slice(0, 100).filter(item => isRetainedLive(item, at)).map(item => item.payload as JsonObject)
  .filter(p => !p.discarded && (p.retry as JsonObject | undefined)?.status !== 'completed')
  .map(p => { const retry = p.retry as JsonObject | undefined; return { id: p.id, receivedAt: p.receivedAt, institution: p.institution,
    reason: p.reason, details: p.details, ...(retry?.status === 'queued' || retry?.status === 'completed' ? { retry } : {}) }; });

import type { JsonObject } from '../http/response.js';
import type { EventFeed } from './month-feed.js';
import { readSourceDetail, readSourceFeed } from './source-reads.js';
import { readSqlDetail, readSqlFeed } from './sql-reads.js';

export type LedgerReadMode = 'dynamodb' | 'shadow' | 'guarded-sql';
export const ledgerReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_LEDGER_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};
// Match the serialized public contract, including array order; object member order isn't meaningful.
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export const samePublicResult = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
export type ReadOutcome = 'equal' | 'mismatch' | 'sql-error';

export const observe = (query: 'month' | 'detail' | 'plan' | 'payroll-month' | 'payroll-income' | 'payroll-year' | 'payroll-detail', mode: LedgerReadMode, outcome: ReadOutcome, selected: 'sql' | 'dynamodb'): void => {
  // Domain comparison cannot be inferred from native Lambda platform metrics. No IDs, payloads, sums or driver errors.
  console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'Olbia/DsqlReads', Dimensions: [['Query']],
      Metrics: [{ Name: 'SqlSelected', Unit: 'Count' }, { Name: 'SourceSelected', Unit: 'Count' },
        { Name: 'Mismatch', Unit: 'Count' }, { Name: 'SqlError', Unit: 'Count' }] }] },
    Query: query, Mode: mode, Outcome: outcome, SqlSelected: Number(selected === 'sql'),
    SourceSelected: Number(selected === 'dynamodb'), Mismatch: Number(outcome === 'mismatch'), SqlError: Number(outcome === 'sql-error'),
  }));
};

export const selectLedgerRead = async <T>(input: {
  mode: LedgerReadMode; sql: () => Promise<T>; source: () => Promise<T>;
  report?: (outcome: ReadOutcome, selected: 'sql' | 'dynamodb') => void;
}): Promise<T> => {
  if (input.mode === 'dynamodb') return input.source();
  // Resolve SQL first, then read the source. A source failure must propagate, never serve unverified SQL.
  const sql = await Promise.resolve().then(input.sql).then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
  const source = await input.source();
  const outcome = !sql.ok ? 'sql-error' : samePublicResult(sql.value, source) ? 'equal' : 'mismatch';
  const selected = sql.ok && outcome === 'equal' && input.mode === 'guarded-sql' ? 'sql' : 'dynamodb';
  input.report?.(outcome, selected);
  return selected === 'sql' && sql.ok ? sql.value : source;
};

export const readConfiguredFeed = (months: readonly string[], legacySource: () => Promise<EventFeed>): Promise<EventFeed> => {
  const mode = ledgerReadMode();
  return selectLedgerRead({ mode, sql: () => readSqlFeed(months),
    source: mode === 'dynamodb' ? legacySource : () => readSourceFeed(months),
    report: (outcome, selected) => observe('month', mode, outcome, selected) });
};
export const readConfiguredDetail = (id: string, legacySource: () => Promise<JsonObject | undefined>): Promise<JsonObject | undefined> => {
  const mode = ledgerReadMode();
  return selectLedgerRead({ mode, sql: () => readSqlDetail(id),
    source: mode === 'dynamodb' ? legacySource : () => readSourceDetail(id),
    report: (outcome, selected) => observe('detail', mode, outcome, selected) });
};

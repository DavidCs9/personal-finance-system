import { verifyNativeMonthlyDeliveries } from '../reports/delivery-verification.js';
import { currentStoreTransaction } from '@finance/ledger/dsql-store';
import { publicThread, isValidAssistantThreadId } from '../agent/threads.js';
import { createPool } from '@finance/ledger/dsql-connection';
import { paginateScan } from '@aws-sdk/lib-dynamodb';
import { database, tableName } from '../http/clients.js';
import { type ReadSqlClient } from '../events/sql-reads.js';
import { samePublicResult } from '../events/read-selection.js';
import type { JsonObject } from '../http/response.js';
import { operationalReadMode, isRetainedLive, publicExceptions, readOperationalPartition, readOperationalItem,
  sqlOperationalPartition } from './reads.js';
import { terminalImportDisplay } from './import-display.js';
import { verifyNativePushSubscriptions } from '../push/read-verification.js';
import { verifyNativeImports } from '../imports/read-verification.js';

// Independent inventory/columns: intentionally does not use projector classification or transformation as oracle.
export const operationalFamilies = ['dedupe_claims', 'exception_claims', 'ingestion_exceptions', 'ingestion_retries', 'import_records', 'bulk_edit_operations', 'delivery_records', 'push_subscriptions', 'assistant_threads'] as const;
export type OperationalFamily = typeof operationalFamilies[number];
export const operationalFamily = (item: JsonObject): OperationalFamily | undefined => {
  const pk = String(item.PK), sk = String(item.SK);
  if (pk.startsWith('DEDUPE#') && sk === 'CLAIM') return 'dedupe_claims';
  if (pk.startsWith('EXCEPTION_DEDUPE#') && sk === 'CLAIM') return 'exception_claims';
  if (pk.startsWith('EXCEPTION#') && sk === 'EXCEPTION') return 'ingestion_exceptions';
  if (pk.startsWith('RETRY#') && (sk === 'DISPATCH' || sk.startsWith('DISPATCH#'))) return 'ingestion_retries';
  if (pk.startsWith('BULK_EDIT#') && sk.startsWith('OP#')) return 'bulk_edit_operations';
  if (!pk.startsWith('USER#')) return;
  if (/^IMPORT#(AMEX|SANTANDER|SANTANDER_STATEMENT)#[^#]+$/.test(sk)) return 'import_records';
  if (/^(MONTHLY_CLOSE|MONTH_END_BALANCE_REMINDER)#\d{4}-\d{2}$/.test(sk)) return 'delivery_records';
  if (sk.startsWith('PUSH#')) return 'push_subscriptions';
  if (sk.startsWith('ASSISTANT_THREAD#')) return 'assistant_threads';
};
const nullable = (value: unknown) => value ?? null;
export const expectedOperationalRow = (item: JsonObject, family: OperationalFamily): JsonObject => {
  const p = (item.payload ?? item) as JsonObject;
  const id = family === 'bulk_edit_operations' ? p.operationId : family === 'ingestion_exceptions' ? p.id
    : family === 'assistant_threads' ? String(item.SK).substring(17) : family === 'push_subscriptions' ? item.subscriptionId : item.SK;
  const owner = item.owner ?? (String(item.PK).startsWith('USER#') ? String(item.PK).substring(5)
    : String(item.PK).startsWith('BULK_EDIT#') ? String(item.PK).substring(10) : p.owner);
  return { source_pk: item.PK, source_sk: item.SK, row_id: id, id, owner: nullable(owner), entity_type: item.entityType,
    status: nullable(p.status), created_at: nullable(p.createdAt ?? p.previewedAt ?? p.claimedAt), updated_at: nullable(p.updatedAt),
    expires_at: item.expiresAt == null ? null : String(item.expiresAt), payload: p, source_item: item,
    ...(family === 'dedupe_claims' ? { event_id: nullable(item.eventId), observation_id: nullable(item.observationId) } : {}),
    ...(family === 'exception_claims' ? { source_dedupe_key: nullable(item.sourceDedupeKey), extractor_version: nullable(item.extractorVersion) } : {}),
    ...(family === 'ingestion_exceptions' ? { received_at: nullable(p.receivedAt), retry_status: nullable((p.retry as JsonObject | undefined)?.status), discarded: Boolean(p.discarded), index_pk: nullable(item.GSI1PK), index_sk: nullable(item.GSI1SK) } : {}),
    ...(family === 'ingestion_retries' ? { dispatched_at: nullable(item.dispatchedAt), job: nullable(item.job) } : {}),
    ...(family === 'import_records' ? { source: nullable(item.source), applied_at: nullable(item.appliedAt) } : {}),
    ...(family === 'bulk_edit_operations' ? { applied_at: nullable(p.appliedAt), undone_at: nullable(p.undoneAt) } : {}),
    ...(family === 'delivery_records' ? { month: nullable(item.month), prepared_at: nullable(item.preparedAt), sent_at: nullable(item.sentAt), content_sha256: nullable(item.contentSha256) } : {}),
    ...(family === 'push_subscriptions' ? { active: nullable(item.active), content_mode: nullable(item.contentMode) } : {}),
    ...(family === 'assistant_threads' ? { session_id: nullable(item.sessionId), title: nullable(item.title), first_month: nullable(item.firstMonth) } : {}),
  };
};
const normalize = (row: JsonObject): JsonObject => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  key === 'expires_at' && value != null ? String(value) : value != null && key.endsWith('_at') ? new Date(value as string).toISOString() : value]));
const order = (rows: readonly JsonObject[]) => [...rows].sort((a, b) => Buffer.compare(Buffer.from(`${a.source_pk}\0${a.source_sk}\0${a.row_id}`), Buffer.from(`${b.source_pk}\0${b.source_sk}\0${b.row_id}`)));
export const compareOperationalRows = (source: readonly JsonObject[], rows: readonly JsonObject[], family: OperationalFamily): boolean =>
  samePublicResult(order(source.map(item => expectedOperationalRow(item, family)).map(normalize)), order(rows.map(normalize)));

let verifierPool: ReturnType<typeof createPool> | undefined;
export const operationalVerificationPool = (): ReadSqlClient => currentStoreTransaction() ?? (verifierPool ??= createPool('olbia_operational_verifier', { connectionTimeoutMillis: 1500, queryTimeoutMillis: 3000 }));
export const verifyOperationalReads = async (owner: string, now: Date, client?: ReadSqlClient) => {
  const providedClient = client; client ??= operationalVerificationPool();
  const started = Date.now(), source: JsonObject[] = [];
  let sourcePages = 0, targetPages = 0, mismatches = 0, publicResponses = 0, expirationChecks = 0, configuredReads = 0;
  const check = (a: unknown, b: unknown) => { mismatches += Number(!samePublicResult(a, b)); };
  for await (const page of paginateScan({ client: database, pageSize: 25 }, { TableName: tableName, ConsistentRead: true })) {
    source.push(...page.Items ?? []); sourcePages++;
  }
  const retained: Record<string, number> = {}, targets = new Map<OperationalFamily, JsonObject[]>();
  for (const family of operationalFamilies) {
    const records = source.filter(item => operationalFamily(item) === family), rows: JsonObject[] = [];
    let pk = '', sk = '', id = '';
    for (;;) {
      const page = (await client.query(`SELECT * FROM olbia.${family} WHERE (source_pk,source_sk,row_id)>($1,$2,$3) ORDER BY source_pk,source_sk,row_id LIMIT 100`, [pk, sk, id])).rows;
      targetPages++; rows.push(...page);
      if (page.length < 100) break;
      const last = page.at(-1)!; pk = String(last.source_pk); sk = String(last.source_sk); id = String(last.row_id);
    }
    retained[family] = records.length; targets.set(family, rows);
    mismatches += Number(!compareOperationalRows(records, rows, family));
    // Fixed clocks on both sides detect logical TTL filtering independently of native physical deletion.
    const clocks = new Set([Math.floor(now.getTime() / 1000), ...records.flatMap(item => typeof item.expiresAt === 'number' ? [item.expiresAt - 1, item.expiresAt, item.expiresAt + 1] : [])]);
    for (const clock of clocks) {
      const actual = (await client.query(`SELECT source_item FROM olbia.${family} WHERE expires_at IS NULL OR expires_at>$1 ORDER BY source_pk,source_sk,row_id`, [clock])).rows.map(row => row.source_item as JsonObject);
      const expected = records.filter(item => isRetainedLive(item, new Date(clock * 1000))).sort((a, b) => Buffer.compare(Buffer.from(`${a.PK}\0${a.SK}`), Buffer.from(`${b.PK}\0${b.SK}`)));
      check(expected, actual); expirationChecks++;
    }
  }
  const exceptionRecords = source.filter(item => operationalFamily(item) === 'ingestion_exceptions' && item.GSI1PK === 'EXCEPTIONS');
  check(publicExceptions(exceptionRecords, now), publicExceptions(targets.get('ingestion_exceptions')!.map(row => row.source_item as JsonObject), now)); publicResponses++;
  for (const family of ['assistant_threads'] as const) {
    const prefix = 'ASSISTANT_THREAD#';
    const expected = source.filter(item => item.PK === `USER#${owner}` && String(item.SK).startsWith(prefix)).sort((a, b) => Buffer.compare(Buffer.from(String(a.SK)), Buffer.from(String(b.SK))));
    const sql = await sqlOperationalPartition(family, `USER#${owner}`, prefix, client);
    check(expected, sql); check(expected, await readOperationalPartition(family, { database, tableName }, `USER#${owner}`, prefix));
    if (family === 'assistant_threads') {
      const visible = (items: readonly JsonObject[]) => items.filter(item => item.SK !== 'ASSISTANT_THREAD#ACTIVE' && isRetainedLive(item, now))
        .map(publicThread).filter(thread => thread !== undefined).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,20);
      check(visible(expected), visible(sql));
      for (const item of expected) {
        if (typeof item.sessionId !== 'string' || !isValidAssistantThreadId(item.sessionId) || item.SK === 'ASSISTANT_THREAD#ACTIVE') continue;
        const match = sql.find(row => row.SK === item.SK); check(publicThread(item), match ? publicThread(match) : undefined); publicResponses++;
      }
    }
    // Thread transcript, native session discovery, active-state decisions are intentionally never invoked by this read-only gate.
    publicResponses++;
  }
  for (const item of source.filter(item => operationalFamily(item) === 'import_records')) {
    const family = String(item.SK).split('#')[1];
    if (family !== 'AMEX' && family !== 'SANTANDER_STATEMENT') continue;
    const id = String(item.SK).split('#')[2];
    const row = targets.get('import_records')!.find(row => row.source_pk === item.PK && row.source_sk === item.SK);
    check(terminalImportDisplay(id, family, item), terminalImportDisplay(id, family, row?.source_item as JsonObject | undefined)); publicResponses++;
  }
  for (const family of ['ingestion_exceptions', 'assistant_threads'] as const) {
    for (const item of source.filter(item => operationalFamily(item) === family)) {
      // Raw input-only adapters: no PDF polling, retry dispatch, native memory backfill or delivery.
      check(item, await readOperationalItem(family, { database, tableName }, String(item.PK), String(item.SK))); configuredReads++;
    }
  }
  for (const family of ['ingestion_exceptions', 'assistant_threads'] as const) {
    check(undefined, await readOperationalItem(family, { database, tableName }, `USER#${owner}`, '__missing_operational_verification__')); publicResponses++;
  }
  const imports = await verifyNativeImports(owner, source.filter(item=>operationalFamily(item)==='import_records'), client);
  mismatches += imports.mismatches;
  const push = await verifyNativePushSubscriptions(owner, providedClient); mismatches += push.mismatches;
  const deliveries = await verifyNativeMonthlyDeliveries(owner, providedClient); mismatches += deliveries.mismatches;
  return { mode: operationalReadMode(), imports, push, deliveries, retained, sourcePages, targetPages, publicResponses, configuredReads, expirationChecks, mismatches, elapsedMs: Date.now() - started };
};

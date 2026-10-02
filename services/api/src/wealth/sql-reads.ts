import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import type { WealthSnapshot, CardLiabilitySnapshot } from '@finance/domain';
import { listCards, type CardRecord } from '../cards/cards.js';
import { toNativeCardRecord } from '../cards/sql-reads.js';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead, type LedgerReadMode } from '../events/read-selection.js';
import { listCanonicalSnapshotsDynamo, listCanonicalLiabilitySnapshotsDynamo } from './service.js';
import { toPublicSnapshot, toPublicLiabilitySnapshot } from './records.js';

export interface WealthInputs {
  readonly snapshots: readonly WealthSnapshot[];
  readonly liabilitySnapshots: readonly CardLiabilitySnapshot[];
  readonly cards: readonly CardRecord[];
}
export type WealthInputsReader = (owner: string) => Promise<WealthInputs>;
export const wealthReadMode = (): LedgerReadMode => {
  const mode = process.env.DSQL_WEALTH_READ_MODE;
  return mode === 'shadow' || mode === 'guarded-sql' ? mode : 'dynamodb';
};
export const readConfiguredWealth = <T>(query: 'wealth-inputs' | 'wealth-audit', sql: () => Promise<T>, source: () => Promise<T>): Promise<T> => {
  const mode = wealthReadMode();
  return selectLedgerRead({ mode, sql, source, report: (outcome, selected) => observe(query, mode, outcome, selected) });
};

// One SQL snapshot and one bounded query for the complete financial input bundle.
// Audit versions are deliberately absent: they are prior captures, never balances.
export const wealthReadStatement = `SELECT source_item,'asset' AS kind,
    NULL::text AS id,NULL::text AS name,NULL::integer AS cut_off_day,NULL::integer AS payment_due_day,
    NULL::text AS institution,NULL::timestamptz AS created_at,NULL::timestamptz AS updated_at
    FROM olbia.wealth_snapshots WHERE source_pk=$1
  UNION ALL SELECT source_item,'liability',NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM olbia.liability_snapshots WHERE source_pk=$1
  UNION ALL SELECT NULL,'card',id,name,cut_off_day,payment_due_day,institution,created_at,updated_at
    FROM olbia.card_profiles WHERE owner=$2 AND deleted_at IS NULL`;
export const readSqlWealthInputs = async (owner: string, client: ReadSqlClient = readerPool()): Promise<WealthInputs> => {
  const rows = (await client.query(wealthReadStatement, [`USER#${owner}`, owner])).rows;
  // Other domains retain their projection completeness gate until their own normalization.
  if (rows.some(row => row.kind !== 'card' && !row.source_item)) throw new Error('Incomplete Patrimonio projection');
  return {
    snapshots: rows.filter(row => row.kind === 'asset').map(row => toPublicSnapshot(row.source_item as JsonObject))
      .filter((value): value is WealthSnapshot => !!value)
      .sort((a, b) => a.day.localeCompare(b.day) || a.accountId.localeCompare(b.accountId)),
    liabilitySnapshots: rows.filter(row => row.kind === 'liability').map(row => toPublicLiabilitySnapshot(row.source_item as JsonObject))
      .filter((value): value is CardLiabilitySnapshot => !!value)
      .sort((a, b) => a.day.localeCompare(b.day) || a.cardId.localeCompare(b.cardId)),
    cards: rows.filter(row => row.kind === 'card').map(toNativeCardRecord)
      .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id)),
  };
};
export const readSourceWealthInputs: WealthInputsReader = async owner => {
  const [snapshots, liabilitySnapshots, cards] = await Promise.all([
    listCanonicalSnapshotsDynamo(owner), listCanonicalLiabilitySnapshotsDynamo(owner), listCards(owner),
  ]);
  return { snapshots, liabilitySnapshots, cards };
};
export const readConfiguredWealthInputs: WealthInputsReader = owner => readConfiguredWealth('wealth-inputs',
  () => readSqlWealthInputs(owner), () => readSourceWealthInputs(owner));

export const wealthPrefixes = ['WEALTH_SNAP#', 'WEALTH_VER#', 'LIAB_SNAP#', 'LIAB_VER#', 'CARD#'] as const;
export const readSourceWealthRecords = async (owner: string, prefixes: readonly string[] = wealthPrefixes): Promise<JsonObject[]> => {
  const records: JsonObject[] = [];
  for (const prefix of prefixes) {
    for await (const page of paginateQuery({ client: database }, { TableName: tableName, ConsistentRead: true,
      KeyConditionExpression: 'PK=:pk AND begins_with(SK,:prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${owner}`, ':prefix': prefix } })) records.push(...(page.Items ?? []));
  }
  return records.sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
};
export const wealthAuditStatement = `SELECT source_item FROM olbia.wealth_versions WHERE source_pk=$1
  UNION ALL SELECT source_item FROM olbia.liability_versions WHERE source_pk=$1`;
export const readSqlWealthAudit = async (owner: string, client: ReadSqlClient = readerPool()): Promise<JsonObject[]> =>
  (await client.query(wealthAuditStatement, [`USER#${owner}`])).rows.map(row => row.source_item as JsonObject)
    .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
// No new public audit endpoint: explicit retained audit reads support verification and future existing-contract consumers.
export const readWealthAudit = (owner: string): Promise<JsonObject[]> => readConfiguredWealth('wealth-audit',
  () => readSqlWealthAudit(owner), () => readSourceWealthRecords(owner, ['WEALTH_VER#', 'LIAB_VER#']));

import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { observe, selectLedgerRead } from '../events/read-selection.js';
import { domainReadMode } from '../categories/sql-reads.js';
import { listCardsDynamo, toCardRecord, type CardRecord } from './cards.js';

export const cardReadStatement = "SELECT source_item FROM olbia.cards WHERE source_pk=$1 AND source_sk >= 'CARD#' AND source_sk < 'CARD$'";
export const readSqlCards = async (owner: string, client: ReadSqlClient = readerPool()): Promise<readonly CardRecord[]> => {
  const rows = (await client.query(cardReadStatement, [`USER#${owner}`])).rows;
  if (rows.some(row => !row.source_item)) throw new Error('Incomplete card projection');
  return rows.map(row => toCardRecord(row.source_item as Record<string, unknown>)).filter((card): card is CardRecord => !!card)
    .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id));
};
export const readConfiguredCards = (input: Parameters<typeof listCardsDynamo>[0]) => {
  const mode = domainReadMode();
  return selectLedgerRead({ mode, sql: () => readSqlCards(input.owner), source: () => listCardsDynamo(input),
    report: (outcome, selected) => observe('cards', mode, outcome, selected) });
};

import { applicationStoreClient } from '@finance/ledger/dsql-store';
import { isLedgerMovementId } from '@finance/ledger/native-ledger';
import type { BulkEditOperation, BulkEditSnapshot } from './bulk-edits.js';
import type { ReadSqlClient } from './sql-reads.js';

const timestamp = (value: unknown) => new Date(value as string | Date).toISOString();
const money = (value: unknown): number => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid native bulk amount');
  return amount;
};
export const bulkAmount = (members: readonly Pick<BulkEditSnapshot, 'amountMinor'>[]): number =>
  money(members.reduce((sum, member) => sum + member.amountMinor, 0));

/** Original assertions are immutable; the amount is derived from ordered member facts. */
export const readBulkOperation = async (owner: string, id: string, client?: ReadSqlClient): Promise<BulkEditOperation | undefined> => {
  if (!isLedgerMovementId(id)) return undefined;
  const row = (await (client ?? applicationStoreClient()).query(`SELECT operation.*,
    (SELECT COALESCE(jsonb_agg(to_jsonb(member) ORDER BY member.position),'[]'::jsonb)
      FROM olbia.ledger_bulk_members member WHERE member.operation_id=operation.id) AS members
    FROM olbia.ledger_bulk_operations operation WHERE operation.id=$1 AND operation.owner=$2`, [id, owner])).rows[0];
  if (!row) return undefined;
  const events = (row.members as Record<string, unknown>[]).map(member => ({
    id: String(member.movement_id), merchantRaw: String(member.merchant_assertion),
    ...(member.occurred_at_assertion === null ? {} : { occurredAt: timestamp(member.occurred_at_assertion) }),
    status: String(member.status_assertion), amountMinor: money(member.amount_minor_assertion),
    previousTags: member.previous_tags as string[], nextTags: member.next_tags as string[],
    previousCategoryId: member.previous_category_id as string | null, nextCategoryId: member.next_category_id as string | null,
  }));
  return { operationId: String(row.id), owner: String(row.owner), status: row.status as BulkEditOperation['status'],
    createdAt: timestamp(row.created_at), expiresAt: money(row.expires_at),
    selection: row.selection_assertion as BulkEditOperation['selection'], change: row.change_assertion as BulkEditOperation['change'],
    events, amountMinor: bulkAmount(events),
    ...(row.applied_at === null ? {} : { appliedAt: timestamp(row.applied_at) }),
    ...(row.undone_at === null ? {} : { undoneAt: timestamp(row.undone_at) }) };
};

/** Caller owns the complete preview transaction, including its financial snapshot. */
export const insertBulkOperation = async (operation: BulkEditOperation): Promise<void> => {
  const client = applicationStoreClient();
  await client.query(`INSERT INTO olbia.ledger_bulk_operations
    (id,owner,status,created_at,expires_at,selection_assertion,change_assertion)
    VALUES ($1,$2,'pending',$3,$4,$5,$6)`, [operation.operationId, operation.owner, operation.createdAt,
    operation.expiresAt, JSON.stringify(operation.selection), JSON.stringify(operation.change)]);
  for (const [position, member] of operation.events.entries()) await client.query(`INSERT INTO olbia.ledger_bulk_members
    (operation_id,position,movement_id,merchant_assertion,occurred_at_assertion,status_assertion,amount_minor_assertion,
      previous_tags,next_tags,previous_category_id,next_category_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [operation.operationId, position, member.id, member.merchantRaw, member.occurredAt ?? null, member.status, member.amountMinor,
    JSON.stringify(member.previousTags), JSON.stringify(member.nextTags), member.previousCategoryId, member.nextCategoryId]);
};

export const transitionBulkOperation = async (owner: string, id: string, direction: 'apply' | 'undo', at: string): Promise<boolean> => {
  const expected = direction === 'apply' ? 'pending' : 'applied';
  const next = direction === 'apply' ? 'applied' : 'undone';
  const column = direction === 'apply' ? 'applied_at' : 'undone_at';
  return (await applicationStoreClient().query(`UPDATE olbia.ledger_bulk_operations SET status=$3,${column}=$4
    WHERE id=$1 AND owner=$2 AND status=$5 RETURNING id`, [id, owner, next, at, expected])).rows.length === 1;
};

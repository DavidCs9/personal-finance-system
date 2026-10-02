import { randomUUID } from 'node:crypto';
import { buildMsiSchedule } from '@finance/domain';
import type { SqlClient } from './projection.js';
import { saveNativeCapture } from './ledger-capture.js';
import { readLedgerDetail } from './ledger-reads.js';
import { claimIgnoredEmail, insertLedgerRevision, replaceInstallmentPlan, replaceMovementTags,
  setMovementCategory, setMovementPersonalAmount, setMovementStatus } from './ledger-writes.js';

/** Caller guarantees rollback. Exercise runtime privileges and deferred integrity on the real engine. */
export const smokeNativeLedger = async (client: SqlClient, owner: string, categoryId: string): Promise<void> => {
  if ((await client.query('SELECT version FROM olbia.schema_migrations WHERE version=14')).rows.length !== 1)
    throw new Error('Native ledger is not active');
  const at = new Date().toISOString(), token = randomUUID(), id = randomUUID();
  const event = { id, institution: 'santander_mx', eventType: 'card_purchase', status: 'accepted',
    amount: { amountMinor: 10000, currency: 'MXN' }, merchantRaw: `SQL verification ${token}`,
    occurredAt: at, receivedAt: at, ingestedAt: at,
    source: { kind: 'apple_pay_shortcut', requestId: token }, parserVersion: 'sql-verification',
    parseWarnings: ['Original verification warning'] };
  const input = { token, captureSource: 'apple_pay_shortcut' as const, event, reconciliationAt: at };
  const saved = await saveNativeCapture(client, input);
  const replay = await saveNativeCapture(client, input);
  if (!saved.created || saved.eventId !== id || !replay.duplicate || replay.observationId !== saved.observationId)
    throw new Error('Native capture replay failed');
  await setMovementPersonalAmount(client, id, 0);
  await setMovementCategory(client, id, categoryId);
  await replaceMovementTags(client, id, ['verification']);
  await setMovementStatus(client, id, 'needs_review', ['Current verification warning']);
  await insertLedgerRevision(client, { id: randomUUID(), movementId: id, createdAt: at, changedBy: owner,
    changes: { personalAmountMinor: { previous: null, next: 0 } } });
  const changed = await readLedgerDetail(client, id);
  const observation = (changed?.observations as Record<string, unknown>[] | undefined)?.[0];
  if (changed?.personalAmountMinor !== 0 || changed.categoryId !== categoryId || changed.status !== 'needs_review' ||
    JSON.stringify(changed.tags) !== '["verification"]' || JSON.stringify(changed.parseWarnings) !== '["Current verification warning"]' ||
    JSON.stringify(observation?.parseWarnings) !== '["Original verification warning"]' ||
    (changed.revisions as unknown[]).length !== 1) throw new Error('Native financial edit/history failed');
  await setMovementStatus(client, id, 'accepted');
  await setMovementPersonalAmount(client, id, undefined);
  const schedule = buildMsiSchedule({ principalMinor: 10000, months: 3, startMonth: at.slice(0, 7), origin: 'manual' });
  await replaceInstallmentPlan(client, id, schedule);
  if ((await readLedgerDetail(client, id))?.msi === undefined) throw new Error('Native installment creation failed');
  await replaceInstallmentPlan(client, id, undefined);
  if ((await readLedgerDetail(client, id))?.msi !== undefined) throw new Error('Native installment replacement failed');
  const operation = randomUUID();
  await client.query(`INSERT INTO olbia.ledger_bulk_operations
    (id,owner,status,created_at,expires_at,selection_assertion,change_assertion)
    VALUES ($1,$2,'pending',$3,$4,'{}','{}')`, [operation, owner, at, Math.floor(Date.now()/1000)+60]);
  await client.query(`INSERT INTO olbia.ledger_bulk_members
    (operation_id,position,movement_id,merchant_assertion,status_assertion,amount_minor_assertion,
      previous_tags,next_tags,previous_category_id,next_category_id)
    VALUES ($1,0,$2,$3,'accepted',10000,'[]','["verification"]',NULL,$4)`, [operation, id, event.merchantRaw, categoryId]);
  for (const [status, column] of [['applied','applied_at'],['undone','undone_at']] as const) {
    const row = (await client.query(`UPDATE olbia.ledger_bulk_operations SET status=$2,${column}=$3 WHERE id=$1 RETURNING status`,
      [operation, status, at])).rows[0];
    if (row?.status !== status) throw new Error('Native bulk lifecycle failed');
  }
  await insertLedgerRevision(client, { id: randomUUID(), movementId: id, operationId: operation, createdAt: at,
    changedBy: owner, changes: { tags: { previous: [], next: ['verification'] } } });
  const ignored = randomUUID();
  if (!await claimIgnoredEmail(client, ignored, at) || await claimIgnoredEmail(client, ignored, at))
    throw new Error('Native suppression replay failed');
  // Rollback alone never checks initially deferred FKs. Explicitly check them before declaring the smoke valid.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
};

import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  applyEventTagChange,
  isValidCategoryId,
  normalizeEventTags,
} from '@finance/domain';
import { eventMonthPartition } from '@finance/ledger';
import { database, tableName } from '../http/clients.js';
import { localDate } from './queries.js';

const MAX_BULK_EVENTS = 49;
const PREVIEW_TTL_SECONDS = 15 * 60;

type BulkEditAudit = {
  readonly source: 'assistant_confirmed_bulk' | 'assistant_chat_tag_edit';
  readonly applyReason: string;
  readonly undoReason: string;
  readonly tagsOnly?: boolean;
};

const confirmedBulkAudit: BulkEditAudit = {
  source: 'assistant_confirmed_bulk',
  applyReason: 'Edición masiva confirmada.',
  undoReason: 'Edición masiva deshecha.',
};

const assistantTagAudit: BulkEditAudit = {
  source: 'assistant_chat_tag_edit',
  applyReason: 'Tags aplicados desde el chat del asistente.',
  undoReason: 'Tags restaurados desde el chat del asistente.',
  tagsOnly: true,
};

export class InvalidBulkEditError extends Error {}

export type BulkEditChange = {
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  readonly categoryId?: string | null;
};

export type BulkEditSelection = {
  readonly fromDay: string;
  readonly toDay: string;
  readonly statuses?: readonly string[];
};

type BulkEditSnapshot = {
  readonly id: string;
  readonly merchantRaw: string;
  readonly occurredAt?: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly previousTags: readonly string[];
  readonly nextTags: readonly string[];
  readonly previousCategoryId: string | null;
  readonly nextCategoryId: string | null;
};

export type BulkEditOperation = {
  readonly operationId: string;
  readonly owner: string;
  readonly status: 'pending' | 'applied' | 'undone';
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly selection: BulkEditSelection & { readonly statuses: readonly ['accepted'] };
  readonly change: BulkEditChange;
  readonly events: readonly BulkEditSnapshot[];
  readonly amountMinor: number;
  readonly appliedAt?: string;
  readonly undoneAt?: string;
};

export type BulkEditPreview = {
  readonly operationId: string;
  readonly status: BulkEditOperation['status'];
  readonly expiresAt: string;
  readonly fromDay: string;
  readonly toDay: string;
  readonly movementCount: number;
  readonly amountMinor: number;
  readonly change: BulkEditChange;
  readonly sample: readonly Pick<BulkEditSnapshot, 'id' | 'merchantRaw' | 'occurredAt' | 'amountMinor'>[];
};

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

const assertDay = (value: string, label: string): void => {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!dayPattern.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidBulkEditError(`${label} debe usar YYYY-MM-DD.`);
  }
};

const monthsBetween = (fromDay: string, toDay: string): readonly string[] => {
  const cursor = new Date(`${fromDay.slice(0, 7)}-01T12:00:00.000Z`);
  const end = toDay.slice(0, 7);
  const months: string[] = [];
  while (months.length <= 24) {
    const month = cursor.toISOString().slice(0, 7);
    months.push(month);
    if (month === end) return months;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  throw new InvalidBulkEditError('El rango masivo no puede exceder 24 meses.');
};

const parseChange = (raw: BulkEditChange): BulkEditChange => {
  const addTags = normalizeEventTags(raw.addTags ?? []);
  const removeTags = normalizeEventTags(raw.removeTags ?? []);
  const hasCategory = Object.prototype.hasOwnProperty.call(raw, 'categoryId');
  if (hasCategory && raw.categoryId !== null) {
    if (typeof raw.categoryId !== 'string' || !isValidCategoryId(raw.categoryId)) {
      throw new InvalidBulkEditError('categoryId es inválida.');
    }
  }
  if (addTags.length === 0 && removeTags.length === 0 && !hasCategory) {
    throw new InvalidBulkEditError('La edición no contiene cambios.');
  }
  return {
    ...(addTags.length > 0 ? { addTags } : {}),
    ...(removeTags.length > 0 ? { removeTags } : {}),
    ...(hasCategory ? { categoryId: raw.categoryId ?? null } : {}),
  };
};

export const parseBulkEditInput = (raw: unknown): {
  readonly selection: BulkEditSelection & { readonly statuses: readonly ['accepted'] };
  readonly change: BulkEditChange;
} => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidBulkEditError('El body debe ser un objeto.');
  }
  const body = raw as Record<string, unknown>;
  const selection = body.selection as Record<string, unknown> | undefined;
  const change = body.change as BulkEditChange | undefined;
  const fromDay = typeof selection?.fromDay === 'string' ? selection.fromDay : '';
  const toDay = typeof selection?.toDay === 'string' ? selection.toDay : '';
  assertDay(fromDay, 'fromDay');
  assertDay(toDay, 'toDay');
  if (fromDay > toDay) throw new InvalidBulkEditError('fromDay no puede ser posterior a toDay.');
  const statuses = selection?.statuses;
  if (statuses !== undefined && (!Array.isArray(statuses)
    || statuses.length !== 1 || statuses[0] !== 'accepted')) {
    throw new InvalidBulkEditError('PR 1 sólo permite movimientos accepted.');
  }
  return {
    selection: { fromDay, toDay, statuses: ['accepted'] },
    change: parseChange(change ?? {}),
  };
};

const queryRangeEvents = async (selection: BulkEditSelection): Promise<readonly Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  for (const month of monthsBetween(selection.fromDay, selection.toDay)) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await database.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :partition',
        ExpressionAttributeValues: { ':partition': eventMonthPartition(month) },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }
  return items;
};

const publicPreview = (operation: BulkEditOperation): BulkEditPreview => ({
  operationId: operation.operationId,
  status: operation.status,
  expiresAt: new Date(operation.expiresAt * 1000).toISOString(),
  fromDay: operation.selection.fromDay,
  toDay: operation.selection.toDay,
  movementCount: operation.events.length,
  amountMinor: operation.amountMinor,
  change: operation.change,
  sample: operation.events.slice(0, 8).map(({ id, merchantRaw, occurredAt, amountMinor }) => ({
    id, merchantRaw, occurredAt, amountMinor,
  })),
});

export const previewBulkEdit = async (
  owner: string,
  input: { readonly selection: BulkEditSelection & { readonly statuses: readonly ['accepted'] }; readonly change: BulkEditChange },
  now = new Date(),
): Promise<BulkEditPreview> => {
  const rows = await queryRangeEvents(input.selection);
  const hasCategory = Object.prototype.hasOwnProperty.call(input.change, 'categoryId');
  const events: BulkEditSnapshot[] = [];
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || payload.status !== 'accepted') continue;
    const day = localDate(payload.occurredAt ?? payload.receivedAt);
    if (!day || day < input.selection.fromDay || day > input.selection.toDay) continue;
    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id) continue;
    const previousTags = normalizeEventTags(Array.isArray(payload.tags) ? payload.tags.map(String) : []);
    const nextTags = applyEventTagChange(previousTags, input.change);
    const previousCategoryId = typeof payload.categoryId === 'string' ? payload.categoryId : null;
    const nextCategoryId = hasCategory ? input.change.categoryId ?? null : previousCategoryId;
    if (JSON.stringify(previousTags) === JSON.stringify(nextTags)
      && previousCategoryId === nextCategoryId) continue;
    const amount = payload.amount as { amountMinor?: unknown } | undefined;
    const amountMinor = typeof payload.personalAmountMinor === 'number'
      ? payload.personalAmountMinor
      : Number(amount?.amountMinor ?? 0);
    events.push({
      id,
      merchantRaw: String(payload.merchantRaw ?? ''),
      occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : undefined,
      status: 'accepted',
      amountMinor,
      previousTags,
      nextTags,
      previousCategoryId,
      nextCategoryId,
    });
  }
  if (events.length === 0) throw new InvalidBulkEditError('No hay movimientos elegibles para este cambio.');
  if (events.length > MAX_BULK_EVENTS) {
    throw new InvalidBulkEditError(`El cambio afecta ${events.length} movimientos; el máximo es ${MAX_BULK_EVENTS}.`);
  }
  const operationId = randomUUID();
  const operation: BulkEditOperation = {
    operationId,
    owner,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + PREVIEW_TTL_SECONDS,
    selection: input.selection,
    change: input.change,
    events,
    amountMinor: events.reduce((sum, event) => sum + event.amountMinor, 0),
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `BULK_EDIT#${owner}`,
      SK: `OP#${operationId}`,
      entityType: 'bulk_edit_operation',
      expiresAt: operation.expiresAt,
      payload: operation,
    },
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));
  return publicPreview(operation);
};

const getOperation = async (owner: string, operationId: string): Promise<BulkEditOperation> => {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `BULK_EDIT#${owner}`, SK: `OP#${operationId}` },
    ConsistentRead: true,
  }));
  const operation = result.Item?.payload as BulkEditOperation | undefined;
  if (!operation || operation.owner !== owner) throw new InvalidBulkEditError('La propuesta no existe.');
  return operation;
};

const eventUpdate = (
  snapshot: BulkEditSnapshot,
  direction: 'apply' | 'undo',
): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Update']> => {
  const fromTags = direction === 'apply' ? snapshot.previousTags : snapshot.nextTags;
  const toTags = direction === 'apply' ? snapshot.nextTags : snapshot.previousTags;
  const fromCategory = direction === 'apply' ? snapshot.previousCategoryId : snapshot.nextCategoryId;
  const toCategory = direction === 'apply' ? snapshot.nextCategoryId : snapshot.previousCategoryId;
  const categoryChanges = snapshot.previousCategoryId !== snapshot.nextCategoryId;
  const names: Record<string, string> = { '#payload': 'payload', '#tags': 'tags', '#status': 'status' };
  const values: Record<string, unknown> = {
    ':accepted': 'accepted', ':fromTags': fromTags, ':toTags': toTags,
  };
  let updateExpression = 'SET #payload.#tags = :toTags';
  let conditionExpression = '#payload.#status = :accepted AND (attribute_not_exists(#payload.#tags) OR #payload.#tags = :fromTags)';
  if (categoryChanges) {
    names['#categoryId'] = 'categoryId';
    values[':fromCategory'] = fromCategory;
    conditionExpression += ' AND (attribute_not_exists(#payload.#categoryId) OR #payload.#categoryId = :fromCategory)';
    if (toCategory === null) updateExpression += ' REMOVE #payload.#categoryId';
    else {
      updateExpression += ', #payload.#categoryId = :toCategory';
      values[':toCategory'] = toCategory;
    }
  }
  return {
    TableName: tableName,
    Key: { PK: `EVENT#${snapshot.id}`, SK: 'EVENT' },
    UpdateExpression: updateExpression,
    ConditionExpression: conditionExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
};

const revisionPut = (
  snapshot: BulkEditSnapshot,
  operation: BulkEditOperation,
  direction: 'apply' | 'undo',
  changedBy: string,
  at: string,
  audit: BulkEditAudit,
): NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Put']> => {
  const previousTags = direction === 'apply' ? snapshot.previousTags : snapshot.nextTags;
  const nextTags = direction === 'apply' ? snapshot.nextTags : snapshot.previousTags;
  const previousCategoryId = direction === 'apply' ? snapshot.previousCategoryId : snapshot.nextCategoryId;
  const nextCategoryId = direction === 'apply' ? snapshot.nextCategoryId : snapshot.previousCategoryId;
  const changes: Record<string, { previous: unknown; next: unknown }> = {
    tags: { previous: previousTags, next: nextTags },
  };
  if (previousCategoryId !== nextCategoryId) {
    changes.categoryId = { previous: previousCategoryId, next: nextCategoryId };
  }
  const revisionId = `${operation.operationId}-${direction}-${snapshot.id}`;
  return {
    TableName: tableName,
    Item: {
      PK: `EVENT#${snapshot.id}`,
      SK: `REVISION#${at}#${revisionId}`,
      entityType: 'event_revision',
      payload: {
        id: revisionId,
        observedPurchaseId: snapshot.id,
        operationId: operation.operationId,
        createdAt: at,
        changedBy,
        source: audit.source,
        reason: direction === 'apply' ? audit.applyReason : audit.undoReason,
        changes,
      },
    },
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  };
};

const transactOperation = async (
  owner: string,
  operationId: string,
  changedBy: string,
  direction: 'apply' | 'undo',
  now = new Date(),
  audit = confirmedBulkAudit,
): Promise<BulkEditPreview> => {
  const operation = await getOperation(owner, operationId);
  if (audit.tagsOnly && Object.prototype.hasOwnProperty.call(operation.change, 'categoryId')) {
    throw new InvalidBulkEditError('La tool del asistente sólo puede modificar tags.');
  }
  if (direction === 'apply' && operation.status === 'applied') return publicPreview(operation);
  if (direction === 'undo' && operation.status === 'undone') return publicPreview(operation);
  const expectedStatus = direction === 'apply' ? 'pending' : 'applied';
  if (operation.status !== expectedStatus) throw new InvalidBulkEditError('La operación no está disponible en este estado.');
  if (direction === 'apply' && operation.expiresAt <= Math.floor(now.getTime() / 1000)) {
    throw new InvalidBulkEditError('La propuesta expiró. Genera un preview nuevo.');
  }
  const nextStatus = direction === 'apply' ? 'applied' : 'undone';
  const timestampField = direction === 'apply' ? 'appliedAt' : 'undoneAt';
  const at = now.toISOString();
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = operation.events.flatMap((event) => [
    { Update: eventUpdate(event, direction) },
    { Put: revisionPut(event, operation, direction, changedBy, at, audit) },
  ]);
  transactItems.push({ Update: {
    TableName: tableName,
    Key: { PK: `BULK_EDIT#${owner}`, SK: `OP#${operationId}` },
    UpdateExpression: 'SET #payload.#status = :nextStatus, #payload.#timestamp = :at REMOVE #ttl',
    ConditionExpression: '#payload.#status = :expectedStatus',
    ExpressionAttributeNames: {
      '#payload': 'payload', '#status': 'status', '#timestamp': timestampField, '#ttl': 'expiresAt',
    },
    ExpressionAttributeValues: { ':expectedStatus': expectedStatus, ':nextStatus': nextStatus, ':at': at },
  } });
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: transactItems,
      ClientRequestToken: `${direction}-${operationId}`.slice(0, 36),
    }));
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'TransactionCanceledException') {
      throw new InvalidBulkEditError('Los movimientos cambiaron después del preview. Genera uno nuevo.');
    }
    throw error;
  }
  return publicPreview({ ...operation, status: nextStatus, [timestampField]: at });
};

export const applyBulkEdit = (
  owner: string,
  operationId: string,
  changedBy: string,
  now?: Date,
): Promise<BulkEditPreview> => transactOperation(owner, operationId, changedBy, 'apply', now);

export const undoBulkEdit = (
  owner: string,
  operationId: string,
  changedBy: string,
  now?: Date,
): Promise<BulkEditPreview> => transactOperation(owner, operationId, changedBy, 'undo', now);

export const applyAgentTagEdit = (
  owner: string,
  operationId: string,
  now?: Date,
): Promise<BulkEditPreview> => transactOperation(
  owner,
  operationId,
  owner,
  'apply',
  now,
  assistantTagAudit,
);

export const undoAgentTagEdit = (
  owner: string,
  operationId: string,
  now?: Date,
): Promise<BulkEditPreview> => transactOperation(
  owner,
  operationId,
  owner,
  'undo',
  now,
  assistantTagAudit,
);

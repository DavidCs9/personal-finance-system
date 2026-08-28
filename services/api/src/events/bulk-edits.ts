import { createHash, randomUUID } from 'node:crypto';
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  applyEventTagChange,
  isValidCategoryId,
  normalizeEventTags,
} from '@finance/domain';
import { eventMonthPartition } from '@finance/ledger';
import { database, tableName } from '../http/clients.js';
import { localDate } from './queries.js';

const MAX_BULK_EVENTS = 49;
const MAX_CATEGORY_BATCH_OPERATIONS = 12;
const MAX_TAG_BATCH_OPERATIONS = 12;
const PREVIEW_TTL_SECONDS = 15 * 60;

type BulkEditAudit = {
  readonly source: 'assistant_confirmed_bulk' | 'assistant_chat_tag_edit' | 'assistant_chat_category_edit';
  readonly applyReason: string;
  readonly undoReason: string;
  readonly tagsOnly?: boolean;
  readonly categoriesOnly?: boolean;
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

const assistantCategoryAudit: BulkEditAudit = {
  source: 'assistant_chat_category_edit',
  applyReason: 'Categoría aplicada desde el chat del asistente.',
  undoReason: 'Categoría restaurada desde el chat del asistente.',
  categoriesOnly: true,
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
  readonly eventIds?: readonly string[];
  readonly merchantRaw?: string;
  readonly sourceCategoryId?: string;
  readonly onlyUncategorized?: boolean;
  readonly sourceTags?: readonly string[];
  readonly onlyUntagged?: boolean;
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
  readonly dryRun: true;
  readonly operationId: string;
  readonly status: BulkEditOperation['status'];
  readonly expiresAt: string;
  readonly fromDay: string;
  readonly toDay: string;
  readonly movementCount: number;
  readonly amountMinor: number;
  readonly change: BulkEditChange;
  readonly affected: readonly Pick<BulkEditSnapshot, 'id' | 'merchantRaw' | 'occurredAt' | 'amountMinor'>[];
  readonly sample: readonly Pick<BulkEditSnapshot, 'id' | 'merchantRaw' | 'occurredAt' | 'amountMinor'>[];
};

export type AgentCategoryBatchApplyResult = {
  readonly operationCount: number;
  readonly movementCount: number;
  readonly amountMinor: number;
  readonly operations: readonly BulkEditPreview[];
};

export type AgentTagBatchApplyResult = {
  readonly operationCount: number;
  readonly movementCount: number;
  readonly amountMinor: number;
  readonly operations: readonly BulkEditPreview[];
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

const queryEventsById = async (eventIds: readonly string[]): Promise<readonly Record<string, unknown>[]> => {
  const result = await database.send(new BatchGetCommand({
    RequestItems: {
      [tableName]: {
        Keys: eventIds.map((id) => ({ PK: `EVENT#${id}`, SK: 'EVENT' })),
        ConsistentRead: true,
      },
    },
  }));
  if (result.UnprocessedKeys && Object.keys(result.UnprocessedKeys).length > 0) {
    throw new InvalidBulkEditError('No se pudieron leer todos los movimientos seleccionados. Reintenta el preview.');
  }
  return (result.Responses?.[tableName] ?? []) as Record<string, unknown>[];
};

const publicAffectedEvents = (events: readonly BulkEditSnapshot[]) => events.map(({
  id, merchantRaw, occurredAt, amountMinor,
}) => ({ id, merchantRaw, occurredAt, amountMinor }));

const publicPreview = (operation: BulkEditOperation): BulkEditPreview => ({
  dryRun: true,
  operationId: operation.operationId,
  status: operation.status,
  expiresAt: new Date(operation.expiresAt * 1000).toISOString(),
  fromDay: operation.selection.fromDay,
  toDay: operation.selection.toDay,
  movementCount: operation.events.length,
  amountMinor: operation.amountMinor,
  change: operation.change,
  affected: publicAffectedEvents(operation.events),
  sample: publicAffectedEvents(operation.events.slice(0, 8)),
});

const createPreviewOperation = async (
  owner: string,
  selection: BulkEditSelection & { readonly statuses: readonly ['accepted'] },
  change: BulkEditChange,
  events: readonly BulkEditSnapshot[],
  now: Date,
): Promise<BulkEditPreview> => {
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
    selection,
    change,
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
  return createPreviewOperation(owner, input.selection, input.change, events, now);
};

type AgentCategoryEditInput = {
  readonly categoryId: string;
  readonly eventIds?: readonly string[];
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly merchantRaw?: string;
  readonly sourceCategoryId?: string;
  readonly onlyUncategorized: boolean;
};

const merchantKey = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .replace(/\s+/g, ' ')
  .toLowerCase();

const parseEventIds = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_EVENTS) {
    throw new InvalidBulkEditError(`eventIds debe contener entre 1 y ${MAX_BULK_EVENTS} IDs.`);
  }
  const eventIds = value.map((id) => typeof id === 'string' ? id.trim() : '');
  if (eventIds.some((id) => !id) || new Set(eventIds).size !== eventIds.length) {
    throw new InvalidBulkEditError('eventIds debe contener IDs únicos y no vacíos.');
  }
  return eventIds;
};

type AgentTagEditInput = {
  readonly change: BulkEditChange;
  readonly eventIds?: readonly string[];
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly merchantRaw?: string;
  readonly sourceTags?: readonly string[];
  readonly onlyUntagged: boolean;
};

export const parseAgentTagEditInput = (raw: unknown): AgentTagEditInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidBulkEditError('El body debe ser un objeto.');
  }
  const body = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
    throw new InvalidBulkEditError('La tool de tags no acepta categoryId.');
  }
  if (body.eventId !== undefined && body.eventIds !== undefined) {
    throw new InvalidBulkEditError('Envía eventId o eventIds, no ambos.');
  }
  const eventIds = body.eventId === undefined
    ? parseEventIds(body.eventIds)
    : parseEventIds([body.eventId]);
  const hasFromDay = body.fromDay !== undefined;
  const hasToDay = body.toDay !== undefined;
  if (hasFromDay !== hasToDay) {
    throw new InvalidBulkEditError('fromDay y toDay deben enviarse juntos.');
  }
  const fromDay = typeof body.fromDay === 'string' ? body.fromDay : undefined;
  const toDay = typeof body.toDay === 'string' ? body.toDay : undefined;
  if (fromDay && toDay) {
    assertDay(fromDay, 'fromDay');
    assertDay(toDay, 'toDay');
    if (fromDay > toDay) throw new InvalidBulkEditError('fromDay no puede ser posterior a toDay.');
    monthsBetween(fromDay, toDay);
  }
  const merchantRaw = typeof body.merchantRaw === 'string' ? body.merchantRaw.trim() : undefined;
  if (body.merchantRaw !== undefined && !merchantRaw) {
    throw new InvalidBulkEditError('merchantRaw no puede estar vacío.');
  }
  const sourceTags = body.sourceTags === undefined
    ? undefined
    : normalizeEventTags(Array.isArray(body.sourceTags) ? body.sourceTags : []);
  if (body.sourceTags !== undefined && (!sourceTags || sourceTags.length === 0)) {
    throw new InvalidBulkEditError('sourceTags debe contener al menos un tag válido.');
  }
  if (body.onlyUntagged !== undefined && typeof body.onlyUntagged !== 'boolean') {
    throw new InvalidBulkEditError('onlyUntagged debe ser booleano.');
  }
  const onlyUntagged = body.onlyUntagged === true;
  if (sourceTags && onlyUntagged) {
    throw new InvalidBulkEditError('sourceTags y onlyUntagged no se pueden combinar.');
  }
  if (!eventIds && (!fromDay || !toDay || (!merchantRaw && !sourceTags && !onlyUntagged))) {
    throw new InvalidBulkEditError('Los tags requieren eventIds exactos o un rango con merchantRaw, sourceTags u onlyUntagged; nunca sólo fechas.');
  }
  const change = parseChange({
    ...(Array.isArray(body.addTags) ? { addTags: body.addTags } : {}),
    ...(Array.isArray(body.removeTags) ? { removeTags: body.removeTags } : {}),
  });
  return {
    change,
    ...(eventIds ? { eventIds } : {}),
    ...(fromDay ? { fromDay } : {}),
    ...(toDay ? { toDay } : {}),
    ...(merchantRaw ? { merchantRaw } : {}),
    ...(sourceTags ? { sourceTags } : {}),
    onlyUntagged,
  };
};

export const previewAgentTagEdit = async (
  owner: string,
  input: AgentTagEditInput,
  now = new Date(),
): Promise<BulkEditPreview> => {
  const rows = input.eventIds
    ? await queryEventsById(input.eventIds)
    : await queryRangeEvents({ fromDay: input.fromDay!, toDay: input.toDay!, statuses: ['accepted'] });
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = typeof (row.payload as Record<string, unknown> | undefined)?.id === 'string'
      ? String((row.payload as Record<string, unknown>).id)
      : '';
    if (id) rowsById.set(id, row);
  }
  if (input.eventIds && input.eventIds.some((id) => !rowsById.has(id))) {
    throw new InvalidBulkEditError('Uno o más eventIds ya no existen. Vuelve a consultar los movimientos antes de aplicar.');
  }
  const candidateRows = input.eventIds ? input.eventIds.map((id) => rowsById.get(id)!) : rows;
  const events: BulkEditSnapshot[] = [];
  const selectedDays: string[] = [];
  for (const row of candidateRows) {
    const payload = row.payload as Record<string, unknown> | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const day = payload ? localDate(payload.occurredAt ?? payload.receivedAt) : undefined;
    const previousTags = normalizeEventTags(Array.isArray(payload?.tags) ? payload.tags.map(String) : []);
    const matches = Boolean(payload && payload.status === 'accepted' && id && day)
      && (!input.fromDay || (day! >= input.fromDay && day! <= input.toDay!))
      && (!input.merchantRaw || merchantKey(String(payload!.merchantRaw ?? '')) === merchantKey(input.merchantRaw))
      && (!input.sourceTags || input.sourceTags.every((tag) => previousTags.includes(tag)))
      && (!input.onlyUntagged || previousTags.length === 0);
    if (!matches) {
      if (input.eventIds) {
        throw new InvalidBulkEditError(`El movimiento ${id || 'seleccionado'} no coincide con los filtros de tags o ya no es accepted.`);
      }
      continue;
    }
    selectedDays.push(day!);
    const nextTags = applyEventTagChange(previousTags, input.change);
    if (JSON.stringify(previousTags) === JSON.stringify(nextTags)) continue;
    const amount = payload!.amount as { amountMinor?: unknown } | undefined;
    events.push({
      id,
      merchantRaw: String(payload!.merchantRaw ?? ''),
      occurredAt: typeof payload!.occurredAt === 'string'
        ? payload!.occurredAt
        : typeof payload!.receivedAt === 'string' ? payload!.receivedAt : undefined,
      status: 'accepted',
      amountMinor: typeof payload!.personalAmountMinor === 'number'
        ? payload!.personalAmountMinor
        : Number(amount?.amountMinor ?? 0),
      previousTags,
      nextTags,
      previousCategoryId: typeof payload!.categoryId === 'string' ? payload!.categoryId : null,
      nextCategoryId: typeof payload!.categoryId === 'string' ? payload!.categoryId : null,
    });
  }
  const fromDay = input.fromDay ?? selectedDays.slice().sort()[0];
  const toDay = input.toDay ?? selectedDays.slice().sort().at(-1);
  if (!fromDay || !toDay) throw new InvalidBulkEditError('No hay movimientos elegibles para este cambio.');
  return createPreviewOperation(owner, {
    fromDay,
    toDay,
    statuses: ['accepted'],
    ...(input.eventIds ? { eventIds: input.eventIds } : {}),
    ...(input.merchantRaw ? { merchantRaw: input.merchantRaw } : {}),
    ...(input.sourceTags ? { sourceTags: input.sourceTags } : {}),
    ...(input.onlyUntagged ? { onlyUntagged: true } : {}),
  }, input.change, events, now);
};

export const parseAgentCategoryEditInput = (raw: unknown): AgentCategoryEditInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidBulkEditError('El body debe ser un objeto.');
  }
  const body = raw as Record<string, unknown>;
  const categoryId = typeof body.categoryId === 'string' ? body.categoryId : '';
  if (!isValidCategoryId(categoryId)) throw new InvalidBulkEditError('categoryId es inválida.');
  if (body.eventId !== undefined && body.eventIds !== undefined) {
    throw new InvalidBulkEditError('Envía eventId o eventIds, no ambos.');
  }
  const eventIds = body.eventId === undefined
    ? parseEventIds(body.eventIds)
    : parseEventIds([body.eventId]);
  const hasFromDay = body.fromDay !== undefined;
  const hasToDay = body.toDay !== undefined;
  if (hasFromDay !== hasToDay) {
    throw new InvalidBulkEditError('fromDay y toDay deben enviarse juntos.');
  }
  const fromDay = typeof body.fromDay === 'string' ? body.fromDay : undefined;
  const toDay = typeof body.toDay === 'string' ? body.toDay : undefined;
  if (fromDay && toDay) {
    assertDay(fromDay, 'fromDay');
    assertDay(toDay, 'toDay');
    if (fromDay > toDay) throw new InvalidBulkEditError('fromDay no puede ser posterior a toDay.');
    monthsBetween(fromDay, toDay);
  }
  const merchantRaw = typeof body.merchantRaw === 'string' ? body.merchantRaw.trim() : undefined;
  if (body.merchantRaw !== undefined && !merchantRaw) {
    throw new InvalidBulkEditError('merchantRaw no puede estar vacío.');
  }
  const sourceCategoryId = typeof body.sourceCategoryId === 'string' ? body.sourceCategoryId : undefined;
  if (sourceCategoryId && !isValidCategoryId(sourceCategoryId)) {
    throw new InvalidBulkEditError('sourceCategoryId es inválida.');
  }
  if (body.sourceCategoryId !== undefined && !sourceCategoryId) {
    throw new InvalidBulkEditError('sourceCategoryId debe ser una categoría válida.');
  }
  if (body.onlyUncategorized !== undefined && typeof body.onlyUncategorized !== 'boolean') {
    throw new InvalidBulkEditError('onlyUncategorized debe ser booleano.');
  }
  const onlyUncategorized = body.onlyUncategorized === true;
  if (sourceCategoryId && onlyUncategorized) {
    throw new InvalidBulkEditError('sourceCategoryId y onlyUncategorized no se pueden combinar.');
  }
  if (!eventIds && (!fromDay || !toDay || (!merchantRaw && !sourceCategoryId && !onlyUncategorized))) {
    throw new InvalidBulkEditError('Las categorías requieren eventIds exactos o un rango con merchantRaw, sourceCategoryId u onlyUncategorized; nunca sólo fechas.');
  }
  return {
    categoryId,
    ...(eventIds ? { eventIds } : {}),
    ...(fromDay ? { fromDay } : {}),
    ...(toDay ? { toDay } : {}),
    ...(merchantRaw ? { merchantRaw } : {}),
    ...(sourceCategoryId ? { sourceCategoryId } : {}),
    onlyUncategorized,
  };
};

export const previewAgentCategoryEdit = async (
  owner: string,
  input: AgentCategoryEditInput,
  now = new Date(),
): Promise<BulkEditPreview> => {
  const rows = input.eventIds
    ? await queryEventsById(input.eventIds)
    : await queryRangeEvents({ fromDay: input.fromDay!, toDay: input.toDay!, statuses: ['accepted'] });
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = typeof (row.payload as Record<string, unknown> | undefined)?.id === 'string'
      ? String((row.payload as Record<string, unknown>).id)
      : '';
    if (id) rowsById.set(id, row);
  }
  if (input.eventIds && input.eventIds.some((id) => !rowsById.has(id))) {
    throw new InvalidBulkEditError('Uno o más eventIds ya no existen. Vuelve a consultar los movimientos antes de aplicar.');
  }
  const candidateRows = input.eventIds ? input.eventIds.map((id) => rowsById.get(id)!) : rows;
  const events: BulkEditSnapshot[] = [];
  const selectedDays: string[] = [];
  for (const row of candidateRows) {
    const payload = row.payload as Record<string, unknown> | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const day = payload ? localDate(payload.occurredAt ?? payload.receivedAt) : undefined;
    const previousCategoryId = typeof payload?.categoryId === 'string' ? payload.categoryId : null;
    const matches = Boolean(payload && payload.status === 'accepted' && id && day)
      && (!input.fromDay || (day! >= input.fromDay && day! <= input.toDay!))
      && (!input.merchantRaw || merchantKey(String(payload!.merchantRaw ?? '')) === merchantKey(input.merchantRaw))
      && (!input.sourceCategoryId || previousCategoryId === input.sourceCategoryId)
      && (!input.onlyUncategorized || previousCategoryId === null);
    if (!matches) {
      if (input.eventIds) {
        throw new InvalidBulkEditError(`El movimiento ${id || 'seleccionado'} no coincide con los filtros de categoría o ya no es accepted.`);
      }
      continue;
    }
    selectedDays.push(day!);
    if (previousCategoryId === input.categoryId) continue;
    const previousTags = normalizeEventTags(Array.isArray(payload!.tags) ? payload!.tags.map(String) : []);
    const amount = payload!.amount as { amountMinor?: unknown } | undefined;
    events.push({
      id,
      merchantRaw: String(payload!.merchantRaw ?? ''),
      occurredAt: typeof payload!.occurredAt === 'string'
        ? payload!.occurredAt
        : typeof payload!.receivedAt === 'string' ? payload!.receivedAt : undefined,
      status: 'accepted',
      amountMinor: typeof payload!.personalAmountMinor === 'number'
        ? payload!.personalAmountMinor
        : Number(amount?.amountMinor ?? 0),
      previousTags,
      nextTags: previousTags,
      previousCategoryId,
      nextCategoryId: input.categoryId,
    });
  }
  const fromDay = input.fromDay ?? selectedDays.slice().sort()[0];
  const toDay = input.toDay ?? selectedDays.slice().sort().at(-1);
  if (!fromDay || !toDay) throw new InvalidBulkEditError('No hay movimientos elegibles para este cambio.');
  return createPreviewOperation(owner, {
    fromDay,
    toDay,
    statuses: ['accepted'],
    ...(input.eventIds ? { eventIds: input.eventIds } : {}),
    ...(input.merchantRaw ? { merchantRaw: input.merchantRaw } : {}),
    ...(input.sourceCategoryId ? { sourceCategoryId: input.sourceCategoryId } : {}),
    ...(input.onlyUncategorized ? { onlyUncategorized: true } : {}),
  }, { categoryId: input.categoryId }, events, now);
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
  const changes: Record<string, { previous: unknown; next: unknown }> = {};
  if (JSON.stringify(previousTags) !== JSON.stringify(nextTags)) {
    changes.tags = { previous: previousTags, next: nextTags };
  }
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
  if (audit.categoriesOnly && (
    Object.prototype.hasOwnProperty.call(operation.change, 'addTags')
    || Object.prototype.hasOwnProperty.call(operation.change, 'removeTags')
  )) {
    throw new InvalidBulkEditError('La tool del asistente sólo puede modificar categorías.');
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

export const applyAgentTagEdits = async (
  owner: string,
  operationIds: readonly string[],
  now = new Date(),
): Promise<AgentTagBatchApplyResult> => {
  const ids = operationIds.map((operationId) => operationId.trim());
  if (ids.length === 0 || ids.length > MAX_TAG_BATCH_OPERATIONS
    || ids.some((operationId) => !operationId) || new Set(ids).size !== ids.length) {
    throw new InvalidBulkEditError(`operationIds debe contener entre 1 y ${MAX_TAG_BATCH_OPERATIONS} IDs únicos.`);
  }
  const operations = await Promise.all(ids.map((operationId) => getOperation(owner, operationId)));
  for (const operation of operations) {
    if (Object.prototype.hasOwnProperty.call(operation.change, 'categoryId')) {
      throw new InvalidBulkEditError('El apply por lote sólo puede modificar tags.');
    }
  }
  if (operations.every((operation) => operation.status === 'applied')) {
    const previews = operations.map(publicPreview);
    return {
      operationCount: previews.length,
      movementCount: previews.reduce((sum, preview) => sum + preview.movementCount, 0),
      amountMinor: previews.reduce((sum, preview) => sum + preview.amountMinor, 0),
      operations: previews,
    };
  }
  if (operations.some((operation) => operation.status !== 'pending')) {
    throw new InvalidBulkEditError('Las operaciones del lote deben estar todas pendientes o todas aplicadas.');
  }
  if (operations.some((operation) => operation.expiresAt <= Math.floor(now.getTime() / 1000))) {
    throw new InvalidBulkEditError('Una propuesta del lote expiró. Genera previews nuevos.');
  }
  const affectedEventIds = operations.flatMap((operation) => operation.events.map((event) => event.id));
  if (new Set(affectedEventIds).size !== affectedEventIds.length) {
    throw new InvalidBulkEditError('Las operaciones del lote se solapan en uno o más movimientos. Genera previews sin movimientos repetidos.');
  }
  const actionCount = operations.reduce((sum, operation) => sum + (operation.events.length * 2) + 1, 0);
  if (actionCount > 100) {
    throw new InvalidBulkEditError('El lote excede 100 acciones de DynamoDB. Divídelo en grupos más pequeños.');
  }
  const at = now.toISOString();
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = operations.flatMap((operation) => [
    ...operation.events.flatMap((event) => [
      { Update: eventUpdate(event, 'apply') },
      { Put: revisionPut(event, operation, 'apply', owner, at, assistantTagAudit) },
    ]),
    { Update: {
      TableName: tableName,
      Key: { PK: `BULK_EDIT#${owner}`, SK: `OP#${operation.operationId}` },
      UpdateExpression: 'SET #payload.#status = :nextStatus, #payload.#timestamp = :at REMOVE #ttl',
      ConditionExpression: '#payload.#status = :expectedStatus',
      ExpressionAttributeNames: {
        '#payload': 'payload', '#status': 'status', '#timestamp': 'appliedAt', '#ttl': 'expiresAt',
      },
      ExpressionAttributeValues: { ':expectedStatus': 'pending', ':nextStatus': 'applied', ':at': at },
    } },
  ]);
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: transactItems,
      ClientRequestToken: createHash('sha256').update(`apply-tag:${ids.join(':')}`).digest('hex').slice(0, 36),
    }));
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'TransactionCanceledException') {
      throw new InvalidBulkEditError('Los movimientos cambiaron después del preview. Genera un lote nuevo.');
    }
    throw error;
  }
  const previews = operations.map((operation) => publicPreview({ ...operation, status: 'applied', appliedAt: at }));
  return {
    operationCount: previews.length,
    movementCount: previews.reduce((sum, preview) => sum + preview.movementCount, 0),
    amountMinor: previews.reduce((sum, preview) => sum + preview.amountMinor, 0),
    operations: previews,
  };
};

export const applyAgentCategoryEdit = (
  owner: string,
  operationId: string,
  now?: Date,
): Promise<BulkEditPreview> => transactOperation(
  owner,
  operationId,
  owner,
  'apply',
  now,
  assistantCategoryAudit,
);

export const undoAgentCategoryEdit = (
  owner: string,
  operationId: string,
  now?: Date,
): Promise<BulkEditPreview> => transactOperation(
  owner,
  operationId,
  owner,
  'undo',
  now,
  assistantCategoryAudit,
);

export const applyAgentCategoryEdits = async (
  owner: string,
  operationIds: readonly string[],
  now = new Date(),
): Promise<AgentCategoryBatchApplyResult> => {
  const ids = operationIds.map((operationId) => operationId.trim());
  if (ids.length === 0 || ids.length > MAX_CATEGORY_BATCH_OPERATIONS
    || ids.some((operationId) => !operationId) || new Set(ids).size !== ids.length) {
    throw new InvalidBulkEditError(`operationIds debe contener entre 1 y ${MAX_CATEGORY_BATCH_OPERATIONS} IDs únicos.`);
  }
  const operations = await Promise.all(ids.map((operationId) => getOperation(owner, operationId)));
  for (const operation of operations) {
    if (Object.prototype.hasOwnProperty.call(operation.change, 'addTags')
      || Object.prototype.hasOwnProperty.call(operation.change, 'removeTags')) {
      throw new InvalidBulkEditError('El apply por lote sólo puede modificar categorías.');
    }
  }
  if (operations.every((operation) => operation.status === 'applied')) {
    const previews = operations.map(publicPreview);
    return {
      operationCount: previews.length,
      movementCount: previews.reduce((sum, preview) => sum + preview.movementCount, 0),
      amountMinor: previews.reduce((sum, preview) => sum + preview.amountMinor, 0),
      operations: previews,
    };
  }
  if (operations.some((operation) => operation.status !== 'pending')) {
    throw new InvalidBulkEditError('Las operaciones del lote deben estar todas pendientes o todas aplicadas.');
  }
  if (operations.some((operation) => operation.expiresAt <= Math.floor(now.getTime() / 1000))) {
    throw new InvalidBulkEditError('Una propuesta del lote expiró. Genera previews nuevos.');
  }
  const affectedEventIds = operations.flatMap((operation) => operation.events.map((event) => event.id));
  if (new Set(affectedEventIds).size !== affectedEventIds.length) {
    throw new InvalidBulkEditError('Las operaciones del lote se solapan en uno o más movimientos. Genera previews sin movimientos repetidos.');
  }
  const actionCount = operations.reduce((sum, operation) => sum + (operation.events.length * 2) + 1, 0);
  if (actionCount > 100) {
    throw new InvalidBulkEditError('El lote excede 100 acciones de DynamoDB. Divídelo en grupos más pequeños.');
  }
  const at = now.toISOString();
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = operations.flatMap((operation) => [
    ...operation.events.flatMap((event) => [
      { Update: eventUpdate(event, 'apply') },
      { Put: revisionPut(event, operation, 'apply', owner, at, assistantCategoryAudit) },
    ]),
    { Update: {
      TableName: tableName,
      Key: { PK: `BULK_EDIT#${owner}`, SK: `OP#${operation.operationId}` },
      UpdateExpression: 'SET #payload.#status = :nextStatus, #payload.#timestamp = :at REMOVE #ttl',
      ConditionExpression: '#payload.#status = :expectedStatus',
      ExpressionAttributeNames: {
        '#payload': 'payload', '#status': 'status', '#timestamp': 'appliedAt', '#ttl': 'expiresAt',
      },
      ExpressionAttributeValues: { ':expectedStatus': 'pending', ':nextStatus': 'applied', ':at': at },
    } },
  ]);
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: transactItems,
      ClientRequestToken: createHash('sha256').update(`apply-category:${ids.join(':')}`).digest('hex').slice(0, 36),
    }));
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'TransactionCanceledException') {
      throw new InvalidBulkEditError('Los movimientos cambiaron después del preview. Genera un lote nuevo.');
    }
    throw error;
  }
  const previews = operations.map((operation) => publicPreview({ ...operation, status: 'applied', appliedAt: at }));
  return {
    operationCount: previews.length,
    movementCount: previews.reduce((sum, preview) => sum + preview.movementCount, 0),
    amountMinor: previews.reduce((sum, preview) => sum + preview.amountMinor, 0),
    operations: previews,
  };
};

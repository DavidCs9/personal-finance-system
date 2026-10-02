import { randomUUID } from 'node:crypto';
import { applicationStoreClient, withNativeTransaction } from '@finance/ledger/dsql-store';
import { insertLedgerRevision, readLedgerMovements, replaceMovementTags, setMovementCategory } from '@finance/ledger/native-ledger';
import { bulkAmount, insertBulkOperation, readBulkOperation, transitionBulkOperation } from './bulk-storage.js';
import {
  applyEventTagChange,
  isValidCategoryId,
  normalizeEventTags,
} from '@finance/domain';
import { localDate } from './queries.js';
import { InvalidCategoryError, requireCatalogCategories } from '../categories/catalog.js';

const MAX_BULK_EVENTS = 49;
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

const requireBulkCategories = async (ids: readonly (string | null)[]): Promise<void> => {
  try { await requireCatalogCategories(ids); }
  catch (error) {
    if (error instanceof InvalidCategoryError) throw new InvalidBulkEditError(error.message);
    throw error;
  }
};

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

export type BulkEditSnapshot = {
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
  const rows = await readLedgerMovements(applicationStoreClient(), { months: monthsBetween(selection.fromDay, selection.toDay) });
  return rows.sort((a, b) => String(a.occurredAt ?? a.receivedAt).localeCompare(String(b.occurredAt ?? b.receivedAt))
    || String(a.id).localeCompare(String(b.id)));
};
const queryEventsById = (eventIds: readonly string[]): Promise<readonly Record<string, unknown>[]> =>
  readLedgerMovements(applicationStoreClient(), { ids: eventIds });

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
    amountMinor: bulkAmount(events),
  };
  await insertBulkOperation(operation);
  return publicPreview(operation);
};

const previewBulkEditInternal = async (
  owner: string,
  input: { readonly selection: BulkEditSelection & { readonly statuses: readonly ['accepted'] }; readonly change: BulkEditChange },
  now = new Date(),
): Promise<BulkEditPreview> => {
  if (Object.prototype.hasOwnProperty.call(input.change, 'categoryId')) {
    await requireBulkCategories([input.change.categoryId ?? null]);
  }
  const rows = await queryRangeEvents(input.selection);
  const hasCategory = Object.prototype.hasOwnProperty.call(input.change, 'categoryId');
  const events: BulkEditSnapshot[] = [];
  for (const row of rows) {
    const movement = row;
    if (!movement || movement.status !== 'accepted') continue;
    const day = localDate(movement.occurredAt ?? movement.receivedAt);
    if (!day || day < input.selection.fromDay || day > input.selection.toDay) continue;
    const id = typeof movement.id === 'string' ? movement.id : '';
    if (!id) continue;
    const previousTags = normalizeEventTags(Array.isArray(movement.tags) ? movement.tags.map(String) : []);
    const nextTags = applyEventTagChange(previousTags, input.change);
    const previousCategoryId = typeof movement.categoryId === 'string' ? movement.categoryId : null;
    const nextCategoryId = hasCategory ? input.change.categoryId ?? null : previousCategoryId;
    if (JSON.stringify(previousTags) === JSON.stringify(nextTags)
      && previousCategoryId === nextCategoryId) continue;
    const amount = movement.amount as { amountMinor?: unknown } | undefined;
    const amountMinor = typeof movement.personalAmountMinor === 'number'
      ? movement.personalAmountMinor
      : Number(amount?.amountMinor ?? 0);
    events.push({
      id,
      merchantRaw: String(movement.merchantRaw ?? ''),
      occurredAt: typeof movement.occurredAt === 'string' ? movement.occurredAt : undefined,
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

const previewAgentTagEditInternal = async (
  owner: string,
  input: AgentTagEditInput,
  now = new Date(),
): Promise<BulkEditPreview> => {
  const rows = input.eventIds
    ? await queryEventsById(input.eventIds)
    : await queryRangeEvents({ fromDay: input.fromDay!, toDay: input.toDay!, statuses: ['accepted'] });
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (id) rowsById.set(id, row);
  }
  if (input.eventIds && input.eventIds.some((id) => !rowsById.has(id))) {
    throw new InvalidBulkEditError('Uno o más eventIds ya no existen. Vuelve a consultar los movimientos antes de aplicar.');
  }
  const candidateRows = input.eventIds ? input.eventIds.map((id) => rowsById.get(id)!) : rows;
  const events: BulkEditSnapshot[] = [];
  const selectedDays: string[] = [];
  for (const row of candidateRows) {
    const movement = row;
    const id = typeof movement?.id === 'string' ? movement.id : '';
    const day = movement ? localDate(movement.occurredAt ?? movement.receivedAt) : undefined;
    const previousTags = normalizeEventTags(Array.isArray(movement?.tags) ? movement.tags.map(String) : []);
    const matches = Boolean(movement && movement.status === 'accepted' && id && day)
      && (!input.fromDay || (day! >= input.fromDay && day! <= input.toDay!))
      && (!input.merchantRaw || merchantKey(String(movement!.merchantRaw ?? '')) === merchantKey(input.merchantRaw))
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
    const amount = movement!.amount as { amountMinor?: unknown } | undefined;
    events.push({
      id,
      merchantRaw: String(movement!.merchantRaw ?? ''),
      occurredAt: typeof movement!.occurredAt === 'string'
        ? movement!.occurredAt
        : typeof movement!.receivedAt === 'string' ? movement!.receivedAt : undefined,
      status: 'accepted',
      amountMinor: typeof movement!.personalAmountMinor === 'number'
        ? movement!.personalAmountMinor
        : Number(amount?.amountMinor ?? 0),
      previousTags,
      nextTags,
      previousCategoryId: typeof movement!.categoryId === 'string' ? movement!.categoryId : null,
      nextCategoryId: typeof movement!.categoryId === 'string' ? movement!.categoryId : null,
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

const previewAgentCategoryEditInternal = async (
  owner: string,
  input: AgentCategoryEditInput,
  now = new Date(),
): Promise<BulkEditPreview> => {
  await requireBulkCategories([input.categoryId]);
  const rows = input.eventIds
    ? await queryEventsById(input.eventIds)
    : await queryRangeEvents({ fromDay: input.fromDay!, toDay: input.toDay!, statuses: ['accepted'] });
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (id) rowsById.set(id, row);
  }
  if (input.eventIds && input.eventIds.some((id) => !rowsById.has(id))) {
    throw new InvalidBulkEditError('Uno o más eventIds ya no existen. Vuelve a consultar los movimientos antes de aplicar.');
  }
  const candidateRows = input.eventIds ? input.eventIds.map((id) => rowsById.get(id)!) : rows;
  const events: BulkEditSnapshot[] = [];
  const selectedDays: string[] = [];
  for (const row of candidateRows) {
    const movement = row;
    const id = typeof movement?.id === 'string' ? movement.id : '';
    const day = movement ? localDate(movement.occurredAt ?? movement.receivedAt) : undefined;
    const previousCategoryId = typeof movement?.categoryId === 'string' ? movement.categoryId : null;
    const matches = Boolean(movement && movement.status === 'accepted' && id && day)
      && (!input.fromDay || (day! >= input.fromDay && day! <= input.toDay!))
      && (!input.merchantRaw || merchantKey(String(movement!.merchantRaw ?? '')) === merchantKey(input.merchantRaw))
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
    const previousTags = normalizeEventTags(Array.isArray(movement!.tags) ? movement!.tags.map(String) : []);
    const amount = movement!.amount as { amountMinor?: unknown } | undefined;
    events.push({
      id,
      merchantRaw: String(movement!.merchantRaw ?? ''),
      occurredAt: typeof movement!.occurredAt === 'string'
        ? movement!.occurredAt
        : typeof movement!.receivedAt === 'string' ? movement!.receivedAt : undefined,
      status: 'accepted',
      amountMinor: typeof movement!.personalAmountMinor === 'number'
        ? movement!.personalAmountMinor
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
  const operation = await readBulkOperation(owner, operationId);
  if (!operation) throw new InvalidBulkEditError('La propuesta no existe.');
  return operation;
};

const assertAudit = (operation: BulkEditOperation, audit: BulkEditAudit): void => {
  if (audit.tagsOnly && Object.prototype.hasOwnProperty.call(operation.change, 'categoryId')) {
    throw new InvalidBulkEditError('La tool del asistente sólo puede modificar tags.');
  }
  if (audit.categoriesOnly && (Object.prototype.hasOwnProperty.call(operation.change, 'addTags')
    || Object.prototype.hasOwnProperty.call(operation.change, 'removeTags'))) {
    throw new InvalidBulkEditError('La tool del asistente sólo puede modificar categorías.');
  }
};
const mutationRows = (operation: BulkEditOperation): number =>
  1 + operation.events.reduce((rows, member) => rows + 1
    + (member.previousCategoryId !== member.nextCategoryId ? 1 : 0)
    + (JSON.stringify(member.previousTags) !== JSON.stringify(member.nextTags)
      ? member.previousTags.length + member.nextTags.length : 0), 0);
const assertMutationBudget = (operations: readonly BulkEditOperation[]): void => {
  if (1 + operations.reduce((rows, operation) => rows + mutationRows(operation), 0) > 3000)
    throw new InvalidBulkEditError('El lote contiene demasiados cambios. Divídelo en grupos más pequeños.');
};

const mutateOperation = async (operation: BulkEditOperation, direction: 'apply' | 'undo', changedBy: string,
  at: string, audit: BulkEditAudit): Promise<BulkEditPreview> => {
  const client = applicationStoreClient();
  const current = new Map((await readLedgerMovements(client, { ids: operation.events.map(member => member.id) }))
    .map(movement => [String(movement.id), movement]));
  for (const member of operation.events) {
    const movement = current.get(member.id);
    const fromTags = direction === 'apply' ? member.previousTags : member.nextTags;
    const toTags = direction === 'apply' ? member.nextTags : member.previousTags;
    const fromCategory = direction === 'apply' ? member.previousCategoryId : member.nextCategoryId;
    const toCategory = direction === 'apply' ? member.nextCategoryId : member.previousCategoryId;
    const categoryChanges = member.previousCategoryId !== member.nextCategoryId;
    if (!movement || movement.status !== 'accepted' || JSON.stringify(movement.tags) !== JSON.stringify(fromTags)
      || categoryChanges && (movement.categoryId ?? null) !== fromCategory)
      throw new InvalidBulkEditError('Los movimientos cambiaron después del preview. Genera uno nuevo.');
    const changes: Record<string, { previous: unknown; next: unknown }> = {};
    if (JSON.stringify(fromTags) !== JSON.stringify(toTags)) {
      await replaceMovementTags(client, member.id, toTags);
      changes.tags = { previous: fromTags, next: toTags };
    }
    if (categoryChanges) {
      await setMovementCategory(client, member.id, toCategory);
      changes.categoryId = { previous: fromCategory, next: toCategory };
    }
    await insertLedgerRevision(client, { id: `${operation.operationId}-${direction}-${member.id}`,
      movementId: member.id, operationId: operation.operationId, createdAt: at, changedBy, source: audit.source,
      reason: direction === 'apply' ? audit.applyReason : audit.undoReason, changes });
  }
  if (!await transitionBulkOperation(operation.owner, operation.operationId, direction, at))
    throw new InvalidBulkEditError('La operación cambió mientras se aplicaba. Vuelve a consultar su estado.');
  return publicPreview({ ...operation, status: direction === 'apply' ? 'applied' : 'undone',
    ...(direction === 'apply' ? { appliedAt: at } : { undoneAt: at }) });
};

const transactOperationInternal = async (
  owner: string,
  operationId: string,
  changedBy: string,
  direction: 'apply' | 'undo',
  now = new Date(),
  audit = confirmedBulkAudit,
): Promise<BulkEditPreview> => {
  const operation = await getOperation(owner, operationId);
  assertAudit(operation, audit);
  if (direction === 'apply' && operation.status === 'applied') return publicPreview(operation);
  if (direction === 'undo' && operation.status === 'undone') return publicPreview(operation);
  const expectedStatus = direction === 'apply' ? 'pending' : 'applied';
  if (operation.status !== expectedStatus) throw new InvalidBulkEditError('La operación no está disponible en este estado.');
  if (direction === 'apply' && operation.expiresAt <= Math.floor(now.getTime() / 1000)) {
    throw new InvalidBulkEditError('La propuesta expiró. Genera un preview nuevo.');
  }
  await requireBulkCategories(operation.events
    .filter(event => event.previousCategoryId !== event.nextCategoryId)
    .map(event => direction === 'apply' ? event.nextCategoryId : event.previousCategoryId));
  assertMutationBudget([operation]);
  return mutateOperation(operation, direction, changedBy, now.toISOString(), audit);
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

const applyBatch = async (owner: string, operationIds: readonly string[], now: Date, audit: BulkEditAudit): Promise<AgentTagBatchApplyResult> => {
  const ids = operationIds.map(id => id.trim());
  if (!ids.length || ids.length > MAX_TAG_BATCH_OPERATIONS || ids.some(id => !id) || new Set(ids).size !== ids.length)
    throw new InvalidBulkEditError(`operationIds debe contener entre 1 y ${MAX_TAG_BATCH_OPERATIONS} IDs únicos.`);
  const operations = await Promise.all(ids.map(id => getOperation(owner, id)));
  for (const operation of operations) assertAudit(operation, audit);
  if (!operations.every(operation => operation.status === 'applied')) {
    if (operations.some(operation => operation.status !== 'pending'))
      throw new InvalidBulkEditError('Las operaciones del lote deben estar todas pendientes o todas aplicadas.');
    if (operations.some(operation => operation.expiresAt <= Math.floor(now.getTime() / 1000)))
      throw new InvalidBulkEditError('Una propuesta del lote expiró. Genera previews nuevos.');
    const members = operations.flatMap(operation => operation.events);
    if (new Set(members.map(member => member.id)).size !== members.length)
      throw new InvalidBulkEditError('Las operaciones del lote se solapan en uno o más movimientos. Genera previews sin movimientos repetidos.');
    await requireBulkCategories(members.filter(member => member.previousCategoryId !== member.nextCategoryId).map(member => member.nextCategoryId));
    assertMutationBudget(operations);
    const previews: BulkEditPreview[] = [];
    for (const operation of operations) previews.push(await mutateOperation(operation, 'apply', owner, now.toISOString(), audit));
    return batchResult(previews);
  }
  return batchResult(operations.map(publicPreview));
};
const batchResult = (operations: readonly BulkEditPreview[]): AgentTagBatchApplyResult => ({
  operationCount: operations.length, movementCount: operations.reduce((sum, operation) => sum + operation.movementCount, 0),
  amountMinor: bulkAmount(operations), operations,
});
export const applyAgentTagEdits = (owner: string, operationIds: readonly string[], now = new Date()): Promise<AgentTagBatchApplyResult> =>
  withNativeTransaction(() => applyBatch(owner, operationIds, now, assistantTagAudit));

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

export const applyAgentCategoryEdits = (owner: string, operationIds: readonly string[], now = new Date()): Promise<AgentCategoryBatchApplyResult> =>
  withNativeTransaction(() => applyBatch(owner, operationIds, now, assistantCategoryAudit));

export const previewBulkEdit = (...args: Parameters<typeof previewBulkEditInternal>): ReturnType<typeof previewBulkEditInternal> =>
  withNativeTransaction(() => previewBulkEditInternal(...args));

export const previewAgentTagEdit = (...args: Parameters<typeof previewAgentTagEditInternal>): ReturnType<typeof previewAgentTagEditInternal> =>
  withNativeTransaction(() => previewAgentTagEditInternal(...args));

export const previewAgentCategoryEdit = (...args: Parameters<typeof previewAgentCategoryEditInternal>): ReturnType<typeof previewAgentCategoryEditInternal> =>
  withNativeTransaction(() => previewAgentCategoryEditInternal(...args));

const transactOperation = (...args: Parameters<typeof transactOperationInternal>): ReturnType<typeof transactOperationInternal> =>
  withNativeTransaction(() => transactOperationInternal(...args));

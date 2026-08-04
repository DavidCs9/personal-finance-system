import { randomUUID } from 'node:crypto';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  cancelRemainingInstallments,
  completeUnplannedSchedule,
  monthKeyInZone,
  replaceMsiSchedule,
  type MsiPlan,
} from '@finance/domain';
import { InvalidManualEntryError } from './manual-entry-input.js';
import { database, tableName } from '../http/clients.js';
import type { JsonObject } from '../http/response.js';
import { getEventDetail, toPublicEvent } from './queries.js';

export class InvalidMsiError extends Error {}


export const patchEvent = async (
  eventId: string,
  changedBy: string,
  body: string | undefined,
): Promise<JsonObject | undefined> => {
  let parsed: JsonObject = {};
  if (body?.trim()) {
    try {
      const value = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      parsed = value as JsonObject;
    } catch {
      throw new InvalidManualEntryError('PATCH body must be a JSON object when provided.');
    }
  }
  const action = typeof parsed.action === 'string'
    ? parsed.action
    : parsed.status === 'rejected'
      ? 'reject'
      : parsed.status === 'accepted'
        ? 'verify'
        : 'verify';
  if (action === 'reject') return markRejected(eventId, changedBy);
  if (action === 'set_msi') return setEventMsi(eventId, changedBy, parsed);
  if (action === 'clear_msi') return clearEventMsi(eventId, changedBy);
  if (action === 'cancel_msi_remaining') return cancelEventMsiRemaining(eventId, changedBy);
  if (action === 'complete_msi_schedule') return completeEventMsiSchedule(eventId, changedBy, parsed);
  if (action === 'verify') return markVerified(eventId, changedBy);
  throw new InvalidManualEntryError('Unsupported PATCH action.');
};

const readMsiPlan = (value: unknown): MsiPlan | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  return value as MsiPlan;
};

export const persistEventMsi = async (
  eventId: string,
  changedBy: string,
  previous: unknown,
  next: MsiPlan | undefined,
  reason: string,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: next
      ? 'SET #payload.#msi = :msi'
      : 'REMOVE #payload.#msi',
    ExpressionAttributeNames: { '#payload': 'payload', '#msi': 'msi' },
    ...(next ? { ExpressionAttributeValues: { ':msi': next } } : {}),
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason,
    changes: {
      msi: { previous, next: next ?? null },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${revision.createdAt}#${revision.id}`, entityType: 'event_revision', payload: revision },
  }));
  return toPublicEvent(
    updated.Attributes?.payload as JsonObject,
    [revision, ...(Array.isArray(existing.revisions) ? existing.revisions as JsonObject[] : [])],
    Array.isArray(existing.observations) ? existing.observations as JsonObject[] : [],
  );
};

const setEventMsi = async (eventId: string, changedBy: string, body: JsonObject): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const amount = existing.amount as { amountMinor?: number } | undefined;
  const principalMinor = Number(amount?.amountMinor);
  const months = Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > 48) throw new InvalidMsiError('Los meses MSI deben ser un entero entre 1 y 48.');
  if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) throw new InvalidMsiError('El movimiento no tiene un monto válido para MSI.');
  const startMonth = typeof body.startMonth === 'string' && /^\d{4}-\d{2}$/.test(body.startMonth)
    ? body.startMonth
    : monthKeyInZone(new Date(String(existing.occurredAt ?? existing.receivedAt)));
  const cuotaMinor = body.cuotaMinor === undefined ? undefined : Number(body.cuotaMinor);
  if (cuotaMinor !== undefined && (!Number.isSafeInteger(cuotaMinor) || cuotaMinor <= 0)) {
    throw new InvalidMsiError('La cuota MSI debe ser un entero positivo en centavos.');
  }
  const previous = readMsiPlan(existing.msi);
  const plan = replaceMsiSchedule(previous, {
    principalMinor,
    months,
    startMonth,
    origin: previous?.origin === 'amex_auto' ? 'amex_auto' : 'manual',
    ...(cuotaMinor !== undefined ? { cuotaMinor } : {}),
  });
  return persistEventMsi(eventId, changedBy, existing.msi, plan, 'Plan MSI actualizado desde la UI.');
};

const clearEventMsi = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  return persistEventMsi(eventId, changedBy, existing.msi, undefined, 'Plan MSI eliminado desde la UI.');
};

const cancelEventMsiRemaining = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const current = readMsiPlan(existing.msi);
  if (!current) throw new InvalidMsiError('Este movimiento no tiene un plan MSI.');
  return persistEventMsi(
    eventId,
    changedBy,
    current,
    cancelRemainingInstallments(current),
    'Cuotas MSI restantes canceladas manualmente.',
  );
};

const completeEventMsiSchedule = async (
  eventId: string,
  changedBy: string,
  body: JsonObject,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const current = readMsiPlan(existing.msi);
  if (!current) throw new InvalidMsiError('Este movimiento no tiene un plan MSI.');
  const months = Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > 48) throw new InvalidMsiError('Los meses MSI deben ser un entero entre 1 y 48.');
  const startMonth = typeof body.startMonth === 'string' && /^\d{4}-\d{2}$/.test(body.startMonth)
    ? body.startMonth
    : monthKeyInZone(new Date(String(existing.occurredAt ?? existing.receivedAt)));
  const cuotaMinor = body.cuotaMinor === undefined ? undefined : Number(body.cuotaMinor);
  const next = completeUnplannedSchedule(current, {
    months,
    startMonth,
    ...(cuotaMinor !== undefined ? { cuotaMinor } : {}),
  });
  return persistEventMsi(eventId, changedBy, current, next, 'Schedule MSI completado desde la UI.');
};

const markVerified = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const previousWarnings = Array.isArray(existing.parseWarnings) ? existing.parseWarnings : [];
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: 'SET #payload.#status = :status, #payload.#warnings = :warnings',
    ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status', '#warnings': 'parseWarnings' },
    ExpressionAttributeValues: { ':status': 'accepted', ':warnings': [] },
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: 'Marcado como verificado desde la UI.',
    changes: {
      status: { previous: existing.status, next: 'accepted' },
      parseWarnings: { previous: previousWarnings, next: [] },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${revision.createdAt}#${revision.id}`, entityType: 'event_revision', payload: revision },
  }));
  return toPublicEvent(updated.Attributes?.payload as JsonObject, [revision, ...(Array.isArray(existing.revisions) ? existing.revisions as JsonObject[] : [])], Array.isArray(existing.observations) ? existing.observations as JsonObject[] : []);
};

const markRejected = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  if (existing.status === 'rejected') {
    return existing;
  }
  const updated = await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: 'SET #payload.#status = :status',
    ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'rejected' },
    ReturnValues: 'ALL_NEW',
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: 'Marcado como rechazado desde la UI.',
    changes: {
      status: { previous: existing.status, next: 'rejected' },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${revision.createdAt}#${revision.id}`, entityType: 'event_revision', payload: revision },
  }));
  return toPublicEvent(updated.Attributes?.payload as JsonObject, [revision, ...(Array.isArray(existing.revisions) ? existing.revisions as JsonObject[] : [])], Array.isArray(existing.observations) ? existing.observations as JsonObject[] : []);
};

export const markDeferredMsi = async (
  eventId: string,
  changedBy: string,
  deferralIdentity: string,
): Promise<boolean> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return false;
  if (existing.status === 'deferred_msi' || existing.status === 'rejected') return false;
  if (existing.msi) return false;
  const previousWarnings = Array.isArray(existing.parseWarnings) ? existing.parseWarnings : [];
  const warnings = [
    ...previousWarnings.filter((item) => typeof item === 'string' && !/Diferido a MSI/i.test(item)),
    'Diferido a MSI automático Amex (no cuenta en el mes).',
  ];
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
    UpdateExpression: 'SET #payload.#status = :status, #payload.#warnings = :warnings',
    ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status', '#warnings': 'parseWarnings' },
    ExpressionAttributeValues: { ':status': 'deferred_msi', ':warnings': warnings },
  }));
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: `Compra diferida a MSI automático (${deferralIdentity}).`,
    changes: {
      status: { previous: existing.status, next: 'deferred_msi' },
    },
  };
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `EVENT#${eventId}`,
      SK: `REVISION#${revision.createdAt}#${revision.id}`,
      entityType: 'event_revision',
      payload: revision,
    },
  }));
  return true;
};

import { applicationSqlClient, withSqlTransaction } from '@finance/ledger/sql-runtime';
import { randomUUID } from 'node:crypto';
import { insertLedgerRevision, readLedgerDetail, replaceInstallmentPlan, replaceMovementTags,
  setMovementPersonalAmount, setMovementStatus, type BankRowEvidence } from '@finance/ledger/native-ledger';
import {
  normalizeEventTags,
  cancelRemainingInstallments,
  completeUnplannedSchedule,
  monthKeyInZone,
  replaceMsiSchedule,
  type MsiPlan,
} from '@finance/domain';
import { InvalidManualEntryError } from './manual-entry-input.js';
import type { JsonObject } from '../http/response.js';
import { toPublicEvent } from './public-event.js';
import { setEventCategory } from '../categories/service.js';
import { parsePersonalAmountMinor } from './personal-amount.js';

const getEventDetail = async (id: string): Promise<JsonObject | undefined> => {
  const detail = await readLedgerDetail(applicationSqlClient(), id);
  return detail ? toPublicEvent(detail, detail.revisions as JsonObject[], detail.observations as JsonObject[]) : undefined;
};
const saveRevision = async (eventId: string, revision: {
  id: string; createdAt: string; changedBy: string; reason: string;
  changes: Record<string, { previous: unknown; next: unknown }>;
}): Promise<void> => insertLedgerRevision(applicationSqlClient(), { ...revision, movementId: eventId });

export class InvalidMsiError extends Error {}

const patchEventInternal = async (
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
  if (action === 'set_category') return setEventCategoryAction(eventId, changedBy, parsed);
  if (action === 'set_tags') return setEventTags(eventId, changedBy, parsed);
  if (action === 'set_personal_amount') return setEventPersonalAmount(eventId, changedBy, parsed);
  if (action === 'clear_personal_amount') return clearEventPersonalAmount(eventId, changedBy);
  if (action === 'verify') return markVerified(eventId, changedBy);
  throw new InvalidManualEntryError('Unsupported PATCH action.');
};

const readMsiPlan = (value: unknown): MsiPlan | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  return value as MsiPlan;
};

const persistEventPersonalAmount = async (
  eventId: string,
  changedBy: string,
  previous: unknown,
  next: number | undefined,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  await setMovementPersonalAmount(applicationSqlClient(), eventId, next);
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: next === undefined ? 'Mi parte eliminada desde la UI.' : 'Mi parte actualizada desde la UI.',
    changes: {
      personalAmountMinor: { previous: previous ?? null, next: next ?? null },
    },
  };
  await saveRevision(eventId, revision);
  return getEventDetail(eventId);
};

const setEventPersonalAmount = async (
  eventId: string,
  changedBy: string,
  body: JsonObject,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  if (existing.status === 'pending_foreign') {
    throw new InvalidManualEntryError('Espera el cargo Santander en MXN antes de definir Mi parte.');
  }
  if (existing.msi) {
    throw new InvalidManualEntryError('Mi parte todavía no está disponible para compras a MSI.');
  }
  const amount = existing.amount as { amountMinor?: number } | undefined;
  const next = parsePersonalAmountMinor(body.personalAmountMinor, Number(amount?.amountMinor));
  if (existing.personalAmountMinor === next) return existing;
  return persistEventPersonalAmount(eventId, changedBy, existing.personalAmountMinor, next);
};

const clearEventPersonalAmount = async (
  eventId: string,
  changedBy: string,
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  if (existing.personalAmountMinor === undefined) return existing;
  return persistEventPersonalAmount(eventId, changedBy, existing.personalAmountMinor, undefined);
};

const persistEventMsiInternal = async (
  eventId: string,
  changedBy: string,
  previous: unknown,
  next: MsiPlan | undefined,
  reason: string,
  evidence: readonly BankRowEvidence[] = [],
): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  await replaceInstallmentPlan(applicationSqlClient(), eventId, next, evidence);
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
  await saveRevision(eventId, revision);
  return getEventDetail(eventId);
};

const setEventMsi = async (eventId: string, changedBy: string, body: JsonObject): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  if (existing.status === 'pending_foreign') {
    throw new InvalidMsiError('Espera el cargo Santander en MXN antes de configurar MSI.');
  }
  if (existing.personalAmountMinor !== undefined) {
    throw new InvalidMsiError('Usa el total pagado antes de configurar un plan MSI.');
  }
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
  if (existing.personalAmountMinor !== undefined) {
    throw new InvalidMsiError('Usa el total pagado antes de completar un plan MSI.');
  }
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
  if (existing.status === 'pending_foreign') {
    throw new InvalidManualEntryError('Una autorización USD sólo se confirma con el cargo Santander en MXN.');
  }
  const previousWarnings = Array.isArray(existing.parseWarnings) ? existing.parseWarnings : [];
  await setMovementStatus(applicationSqlClient(), eventId, 'accepted', []);
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
  await saveRevision(eventId, revision);
  return getEventDetail(eventId);
};

const markRejected = async (eventId: string, changedBy: string): Promise<JsonObject | undefined> => {
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  if (existing.status === 'rejected') {
    return existing;
  }
  await setMovementStatus(applicationSqlClient(), eventId, 'rejected');
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
  await saveRevision(eventId, revision);
  return getEventDetail(eventId);
};

const markDeferredMsiInternal = async (
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
  await setMovementStatus(applicationSqlClient(), eventId, 'deferred_msi', warnings);
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
  await saveRevision(eventId, revision);
  return true;
};

const setEventCategoryAction = async (
  eventId: string,
  changedBy: string,
  body: JsonObject,
): Promise<JsonObject | undefined> => {
  const rawCategory = body.categoryId;
  const categoryId = rawCategory === null || rawCategory === ''
    ? null
    : typeof rawCategory === 'string'
      ? rawCategory
      : (() => { throw new InvalidManualEntryError('categoryId must be a string or null.'); })();
  const updateRule = body.updateRule === true;
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  await setEventCategory(eventId, changedBy, categoryId, {
    updateRule,
    source: updateRule ? 'human' : 'human',
  });
  return getEventDetail(eventId);
};

const setEventTags = async (
  eventId: string,
  changedBy: string,
  body: JsonObject,
): Promise<JsonObject | undefined> => {
  if (!Array.isArray(body.tags)) throw new InvalidManualEntryError('tags must be an array.');
  const tags = normalizeEventTags(body.tags);
  const existing = await getEventDetail(eventId);
  if (!existing) return undefined;
  const previous = Array.isArray(existing.tags) ? existing.tags.map(String) : [];
  if (JSON.stringify(previous) === JSON.stringify(tags)) return existing;
  await replaceMovementTags(applicationSqlClient(), eventId, tags);
  const revision = {
    id: randomUUID(),
    observedPurchaseId: eventId,
    createdAt: new Date().toISOString(),
    changedBy,
    reason: 'Tags actualizados desde la UI.',
    changes: { tags: { previous, next: tags } },
  };
  await saveRevision(eventId, revision);
  return getEventDetail(eventId);
};

export const patchEvent = (...args: Parameters<typeof patchEventInternal>): ReturnType<typeof patchEventInternal> => withSqlTransaction(() => patchEventInternal(...args));

export const persistEventMsi = (...args: Parameters<typeof persistEventMsiInternal>): ReturnType<typeof persistEventMsiInternal> => withSqlTransaction(() => persistEventMsiInternal(...args));

export const markDeferredMsi = (...args: Parameters<typeof markDeferredMsiInternal>): ReturnType<typeof markDeferredMsiInternal> => withSqlTransaction(() => markDeferredMsiInternal(...args));

import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BatchGetCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MsiPlan } from '@finance/domain';
import { eventMonthIndexKeys, msiPlanPurchaseOccurredAt, reconciliationPartition } from '@finance/ledger';
import { buildPlanFromCreateDecision, isSantanderMsiRow, matchEvidenceLine, type EvidenceLine } from './msi-reconciliation.js';
import {
  InvalidSantanderCsvError,
  merchantsMatch,
  parseSantanderCsv,
  santanderApplyAction,
  santanderImportCompletionUpdate,
  type SantanderCsvDocument,
  type SantanderCsvRow,
  type SantanderReconciliationDecision,
  type SantanderReconciliationStatus,
} from './santander-csv.js';
import { database, rawSourceBucketName, s3, tableName } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { isValidMonth } from '../months/monthly-plan.js';
import { allStoredEvents, localDate, toPublicEvent } from '../events/queries.js';
import { persistEventMsi } from '../events/mutations.js';

interface SantanderPreviewRow extends SantanderCsvRow {
  readonly status: SantanderReconciliationStatus;
  readonly candidateEventIds: readonly string[];
  readonly candidates: readonly { readonly id: string; readonly merchantRaw: string; readonly occurredAt?: string }[];
}

const csvSourceKey = (owner: string, sha256: string): string => `manual-imports/santander/${owner}/${sha256}.csv`;
const rowClaimKey = (identity: string): { readonly PK: string; readonly SK: string } => ({
  PK: `DEDUPE#SANTANDER_CSV#${createHash('sha256').update(identity).digest('hex')}`,
  SK: 'CLAIM',
});

const claimedRowIdentities = async (rows: readonly SantanderCsvRow[]): Promise<ReadonlySet<string>> => {
  const claimed = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += 100) {
    let requestKeys: Record<string, unknown>[] = rows.slice(offset, offset + 100).map((row) => rowClaimKey(row.identity));
    let attempts = 0;
    do {
      if (attempts > 0) await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempts)));
      const result = await database.send(new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: requestKeys, ProjectionExpression: 'PK' } },
      }));
      for (const item of result.Responses?.[tableName] ?? []) claimed.add(String(item.PK));
      requestKeys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
      attempts += 1;
      if (attempts >= 6 && requestKeys.length > 0) throw new Error('Unable to verify Santander CSV dedupe keys after multiple attempts.');
    } while (requestKeys.length > 0);
  }
  return claimed;
};

const candidateEvents = (document: SantanderCsvDocument, row: SantanderCsvRow, events: readonly JsonObject[]): readonly JsonObject[] =>
  events.filter((event) => {
    const account = event.account as JsonObject | undefined;
    const amount = event.amount as JsonObject | undefined;
    return account?.lastFour === document.accountLastFour
      && amount?.currency === 'MXN'
      && amount.amountMinor === row.amountMinor
      && localDate(event.occurredAt ?? event.receivedAt) === row.occurredOn
      && typeof event.merchantRaw === 'string'
      && merchantsMatch(event.merchantRaw, row.merchantRaw);
  });

const classifySantanderRows = async (document: SantanderCsvDocument): Promise<readonly SantanderPreviewRow[]> => {
  const [events, claims] = await Promise.all([allStoredEvents(), claimedRowIdentities(document.rows)]);
  return document.rows.map((row): SantanderPreviewRow => {
    if (claims.has(rowClaimKey(row.identity).PK)) return { ...row, status: 'duplicate', candidateEventIds: [], candidates: [] };
    if (row.amountMinor < 0) return { ...row, status: 'excluded', candidateEventIds: [], candidates: [] };
    if (isSantanderMsiRow(row.merchantRaw) && row.amountMinor > 0) {
      const match = matchEvidenceLine({
        merchantRaw: row.merchantRaw,
        amountMinor: row.amountMinor,
        occurredOn: row.occurredOn,
        identity: row.identity,
      }, events);
      if (match.kind === 'confirm') {
        return {
          ...row,
          status: 'matched',
          candidateEventIds: [match.eventId],
          candidates: [{ id: match.eventId, merchantRaw: row.merchantRaw }],
        };
      }
      if (match.kind === 'needs_decision') {
        const candidates = match.candidates.map((candidate) => ({
          id: candidate.eventId,
          merchantRaw: candidate.merchantRaw,
        }));
        return {
          ...row,
          status: 'needs_decision',
          candidateEventIds: candidates.map((candidate) => candidate.id),
          candidates,
        };
      }
      if (match.kind === 'skip' && match.reason === 'already_confirmed') {
        return { ...row, status: 'duplicate', candidateEventIds: [], candidates: [] };
      }
    }
    const candidates = candidateEvents(document, row, events);
    const candidateSummaries = candidates.map((candidate) => ({
      id: String(candidate.id),
      merchantRaw: String(candidate.merchantRaw),
      ...(typeof candidate.occurredAt === 'string' ? { occurredAt: candidate.occurredAt } : {}),
    }));
    if (!row.transactionId) return { ...row, status: 'ambiguous', candidateEventIds: candidates.map((candidate) => String(candidate.id)), candidates: candidateSummaries };
    if (candidates.length === 1) return { ...row, status: 'matched', candidateEventIds: [String(candidates[0].id)], candidates: candidateSummaries };
    if (candidates.length > 1) return { ...row, status: 'ambiguous', candidateEventIds: candidates.map((candidate) => String(candidate.id)), candidates: candidateSummaries };
    return { ...row, status: 'new', candidateEventIds: [], candidates: [] };
  });
};

const previewPayload = (importId: string, document: SantanderCsvDocument, rows: readonly SantanderPreviewRow[]): JsonObject => {
  const count = (status: SantanderReconciliationStatus) => rows.filter((row) => row.status === status).length;
  return {
    importId,
    accountLastFour: document.accountLastFour,
    product: document.product,
    period: document.period,
    summary: {
      total: rows.length,
      new: count('new'),
      matched: count('matched'),
      ambiguous: count('ambiguous'),
      duplicate: count('duplicate'),
      excluded: count('excluded'),
      needsDecision: count('needs_decision'),
    },
    rows,
  };
};

export const previewSantanderImport = async (body: string | undefined, owner: string): Promise<JsonObject> => {
  if (!body) throw new InvalidSantanderCsvError('Selecciona un archivo CSV de Santander.');
  if (Buffer.byteLength(body, 'utf8') > 2_000_000) throw new InvalidSantanderCsvError('El CSV excede el límite de 2 MB.');
  const document = parseSantanderCsv(body);
  const sourceHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const importId = sourceHash;
  const source = {
    bucket: rawSourceBucketName,
    key: csvSourceKey(owner, sourceHash),
    sha256: sourceHash,
    contentType: 'text/csv',
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: source.key,
    Body: body,
    ContentType: 'text/csv; charset=utf-8',
  }));
  const rows = await classifySantanderRows(document);
  const previewedAt = new Date().toISOString();
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${owner}`,
      SK: `IMPORT#SANTANDER#${importId}`,
      entityType: 'santander_csv_import',
      owner,
      importId,
      status: 'previewed',
      previewedAt,
      source,
      accountLastFour: document.accountLastFour,
      rows,
    },
  }));
  return previewPayload(importId, document, rows);
};

const claimAndCreateCsvEvent = async (
  owner: string,
  document: SantanderCsvDocument,
  row: SantanderPreviewRow,
  source: JsonObject,
  appliedAt: string,
  msi?: MsiPlan,
): Promise<JsonObject | undefined> => {
  const id = randomUUID();
  const observationId = randomUUID();
  const evidenceOccurredAt = `${row.occurredOn}T12:00:00.000Z`;
  const occurredAt = msiPlanPurchaseOccurredAt(row.occurredOn, msi?.installments[0]?.month);
  const purchase: JsonObject = {
    id,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    status: msi?.needsScheduleCompletion ? 'needs_review' : 'accepted',
    account: {
      institution: 'santander_mx',
      accountId: `santander_mx:${document.accountLastFour}`,
      displayName: `Tarjeta terminada en ${document.accountLastFour}`,
      lastFour: document.accountLastFour,
    },
    amount: {
      amountMinor: msi?.principalMinor ?? row.amountMinor,
      currency: 'MXN',
    },
    merchantRaw: row.merchantRaw,
    bankTransactionId: row.transactionId,
    occurredAt,
    receivedAt: appliedAt,
    ingestedAt: appliedAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: msi?.needsScheduleCompletion
      ? ['MSI sin plan completo: confirma meses y cuota.']
      : [],
    captureSource: 'santander_csv',
    captureSources: ['santander_csv'],
    observationCount: 1,
    primaryObservationId: observationId,
    hasRawEmail: false,
    ...(msi ? { msi } : {}),
  };
  const observation = {
    id: observationId,
    eventId: id,
    captureSource: 'santander_csv',
    observedAt: appliedAt,
    reconciliationAt: evidenceOccurredAt,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    account: purchase.account,
    amount: purchase.amount,
    merchantRaw: row.merchantRaw,
    occurredAt: evidenceOccurredAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: [],
    rowNumber: row.rowNumber,
    bankTransactionId: row.transactionId,
  };
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: { ...rowClaimKey(row.identity), entityType: 'santander_csv_dedupe', identity: row.identity, owner, createdAt: appliedAt },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: 'EVENT',
          GSI1PK: 'EVENTS',
          GSI1SK: appliedAt,
          GSI2PK: reconciliationPartition(purchase as Parameters<typeof reconciliationPartition>[0]),
          GSI2SK: `${occurredAt}#${id}`,
          ...eventMonthIndexKeys({ eventId: id, occurredAt, receivedAt: appliedAt }),
          reconciliationAt: occurredAt,
          entityType: 'observed_purchase',
          payload: purchase,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: `OBSERVATION#${evidenceOccurredAt}#${observationId}`,
          entityType: 'event_observation',
          payload: observation,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
    ] }));
    return purchase;
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') return undefined;
    throw error;
  }
};

const claimAndLinkCsvEvidence = async (
  owner: string,
  eventId: string,
  row: SantanderPreviewRow,
  source: JsonObject,
  appliedAt: string,
): Promise<boolean> => {
  const revisionId = randomUUID();
  const observationId = randomUUID();
  const reconciliationAt = `${row.occurredOn}T12:00:00.000Z`;
  const reconciliation = { source, rowNumber: row.rowNumber, transactionId: row.transactionId, reconciledAt: appliedAt };
  const observation = {
    id: observationId,
    eventId,
    captureSource: 'santander_csv',
    observedAt: appliedAt,
    reconciliationAt,
    institution: 'santander_mx',
    eventType: 'card_purchase',
    amount: { amountMinor: row.amountMinor, currency: 'MXN' },
    merchantRaw: row.merchantRaw,
    occurredAt: reconciliationAt,
    source,
    parserVersion: 'santander-mx-csv-v1',
    parseWarnings: [],
    rowNumber: row.rowNumber,
    bankTransactionId: row.transactionId,
  };
  const revision = {
    id: revisionId,
    observedPurchaseId: eventId,
    createdAt: appliedAt,
    changedBy: owner,
    reason: 'Conciliado con un CSV de movimientos Santander.',
    changes: { reconciliation: { previous: null, next: reconciliation } },
  };
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: { ...rowClaimKey(row.identity), entityType: 'santander_csv_dedupe', identity: row.identity, owner, createdAt: appliedAt, eventId },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Update: {
        TableName: tableName,
        Key: { PK: `EVENT#${eventId}`, SK: 'EVENT' },
        UpdateExpression: 'SET #payload.#count = if_not_exists(#payload.#count, :one) + :one, #payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source), #payload.#reconciledAt = :reconciledAt, #payload.#bankTransactionId = :transactionId',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#payload': 'payload', '#count': 'observationCount', '#sources': 'captureSources', '#reconciledAt': 'reconciledAt', '#bankTransactionId': 'bankTransactionId' },
        ExpressionAttributeValues: { ':one': 1, ':empty': [], ':source': ['santander_csv'], ':reconciledAt': appliedAt, ':transactionId': row.transactionId ?? row.identity },
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${eventId}`,
          SK: `OBSERVATION#${reconciliationAt}#${observationId}`,
          entityType: 'event_observation',
          payload: observation,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
      { Put: {
        TableName: tableName,
        Item: { PK: `EVENT#${eventId}`, SK: `REVISION#${appliedAt}#${revisionId}`, entityType: 'event_revision', payload: revision },
      } },
    ] }));
    return true;
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') return false;
    throw error;
  }
};

const parseImportDecisions = (body: string | undefined): Readonly<Record<string, SantanderReconciliationDecision>> => {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { decisions?: unknown };
    if (!parsed.decisions || typeof parsed.decisions !== 'object' || Array.isArray(parsed.decisions)) return {};
    const decisions: Record<string, SantanderReconciliationDecision> = {};
    for (const [identity, raw] of Object.entries(parsed.decisions as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') throw new InvalidSantanderCsvError('Una decisión de conciliación no es válida.');
      const decision = raw as {
        action?: unknown;
        eventId?: unknown;
        months?: unknown;
        cuotaMinor?: unknown;
        startMonth?: unknown;
      };
      if (decision.action === 'create') {
        decisions[identity] = { action: 'create' };
        continue;
      }
      if (decision.action === 'skip') {
        decisions[identity] = { action: 'skip' };
        continue;
      }
      if (decision.action === 'link' || decision.action === 'confirm_msi') {
        if (typeof decision.eventId !== 'string') {
          throw new InvalidSantanderCsvError('Falta el movimiento elegido para una conciliación.');
        }
        decisions[identity] = decision.action === 'link'
          ? { action: 'link', eventId: String(decision.eventId) }
          : { action: 'confirm_msi', eventId: String(decision.eventId) };
        continue;
      }
      if (decision.action === 'create_plan') {
        if (!Number.isInteger(decision.months) || Number(decision.months) < 1 || Number(decision.months) > 48) {
          throw new InvalidSantanderCsvError('Los meses del plan MSI no son válidos.');
        }
        if (!Number.isInteger(decision.cuotaMinor) || Number(decision.cuotaMinor) <= 0) {
          throw new InvalidSantanderCsvError('La cuota del plan MSI no es válida.');
        }
        if (decision.startMonth !== undefined && (typeof decision.startMonth !== 'string' || !isValidMonth(decision.startMonth))) {
          throw new InvalidSantanderCsvError('El mes de inicio del plan MSI no es válido.');
        }
        decisions[identity] = {
          action: 'create_plan',
          months: Number(decision.months),
          cuotaMinor: Number(decision.cuotaMinor),
          ...(typeof decision.startMonth === 'string' ? { startMonth: decision.startMonth } : {}),
        };
        continue;
      }
      throw new InvalidSantanderCsvError('Una decisión de conciliación no es válida.');
    }
    return decisions;
  } catch (error) {
    if (error instanceof InvalidSantanderCsvError) throw error;
    throw new InvalidSantanderCsvError('Las decisiones de conciliación no tienen un formato válido.');
  }
};

export const applySantanderImport = async (importId: string, owner: string, decisionBody: string | undefined): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) throw new InvalidSantanderCsvError('Identificador de importación inválido.');
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER#${importId}` },
    ConsistentRead: true,
  }));
  const source = stored.Item?.source as JsonObject | undefined;
  if (!stored.Item || stored.Item.owner !== owner || typeof source?.key !== 'string') {
    throw new InvalidSantanderCsvError('La previsualización ya no está disponible. Vuelve a seleccionar el CSV.');
  }
  const object = await s3.send(new GetObjectCommand({ Bucket: rawSourceBucketName, Key: source.key }));
  if (!object.Body) throw new Error('The Santander CSV source did not contain a body.');
  const sourceBody = await object.Body.transformToString('utf8');
  const actualHash = createHash('sha256').update(sourceBody, 'utf8').digest('hex');
  if (actualHash !== importId) throw new Error('The stored Santander CSV hash does not match the import identifier.');

  const decisions = parseImportDecisions(decisionBody);
  const document = parseSantanderCsv(sourceBody);
  const rows = await classifySantanderRows(document);
  const previewRows = Array.isArray(stored.Item.rows) ? stored.Item.rows as readonly SantanderPreviewRow[] : [];
  const previewByIdentity = new Map(previewRows.map((row) => [row.identity, row]));
  const appliedAt = new Date().toISOString();
  const created: JsonObject[] = [];
  let linked = 0;
  let skipped = 0;
  let msiConfirmed = 0;
  let eventsSnapshot = await allStoredEvents();
  for (const row of rows) {
    const previewRow = previewByIdentity.get(row.identity);
    const action = santanderApplyAction(row, previewRow, decisions[row.identity]);
    const msiEvidence: EvidenceLine | undefined = isSantanderMsiRow(row.merchantRaw) && row.amountMinor > 0
      ? {
          merchantRaw: row.merchantRaw,
          amountMinor: row.amountMinor,
          occurredOn: row.occurredOn,
          identity: row.identity,
        }
      : undefined;

    if (action.kind === 'confirm_msi' && msiEvidence) {
      const scoped = eventsSnapshot.filter((event) => event.id === action.eventId);
      const match = matchEvidenceLine(msiEvidence, scoped.length > 0 ? scoped : eventsSnapshot);
      if (match.kind === 'confirm' && match.eventId === action.eventId) {
        const updated = await persistEventMsi(
          match.eventId,
          owner,
          match.previous,
          match.next,
          'Cuota MSI confirmada con CSV Santander.',
        );
        if (updated) {
          msiConfirmed += 1;
          linked += 1;
          eventsSnapshot = eventsSnapshot.map((event) => event.id === match.eventId ? { ...event, msi: match.next } : event);
          continue;
        }
      }
      skipped += 1;
      continue;
    }

    if (action.kind === 'create_plan' && msiEvidence) {
      const existing = matchEvidenceLine(msiEvidence, eventsSnapshot);
      if (existing.kind === 'confirm') {
        const updated = await persistEventMsi(
          existing.eventId,
          owner,
          existing.previous,
          existing.next,
          'Cuota MSI confirmada con CSV Santander.',
        );
        if (updated) {
          msiConfirmed += 1;
          linked += 1;
          eventsSnapshot = eventsSnapshot.map((event) => event.id === existing.eventId ? { ...event, msi: existing.next } : event);
          continue;
        }
        skipped += 1;
        continue;
      }
      if (existing.kind === 'skip') {
        skipped += 1;
        continue;
      }
      const plan = buildPlanFromCreateDecision(msiEvidence, {
        months: action.months,
        cuotaMinor: action.cuotaMinor,
        startMonth: action.startMonth,
      });
      const purchase = await claimAndCreateCsvEvent(owner, document, row, source, appliedAt, plan);
      if (purchase) {
        created.push(toPublicEvent(purchase));
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
      continue;
    }

    if (action.kind === 'create') {
      // Matched MSI rows use link/confirm; never invent schedules on plain create.
      if (msiEvidence) {
        const match = matchEvidenceLine(msiEvidence, eventsSnapshot);
        if (match.kind === 'confirm') {
          const updated = await persistEventMsi(
            match.eventId,
            owner,
            match.previous,
            match.next,
            'Cuota MSI confirmada con CSV Santander.',
          );
          if (updated) {
            msiConfirmed += 1;
            linked += 1;
            eventsSnapshot = eventsSnapshot.map((event) => event.id === match.eventId ? { ...event, msi: match.next } : event);
            continue;
          }
        }
        skipped += 1;
        continue;
      }
      const purchase = await claimAndCreateCsvEvent(owner, document, row, source, appliedAt);
      if (purchase) {
        created.push(toPublicEvent(purchase));
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
    } else if (action.kind === 'link') {
      if (msiEvidence) {
        const scoped = eventsSnapshot.filter((event) => event.id === action.eventId);
        const match = matchEvidenceLine(msiEvidence, scoped.length > 0 ? scoped : eventsSnapshot);
        if (match.kind === 'confirm') {
          const updated = await persistEventMsi(
            match.eventId,
            owner,
            match.previous,
            match.next,
            'Cuota MSI confirmada con CSV Santander.',
          );
          if (updated) {
            msiConfirmed += 1;
            eventsSnapshot = eventsSnapshot.map((event) => event.id === match.eventId ? { ...event, msi: match.next } : event);
          }
        }
      }
      if (await claimAndLinkCsvEvidence(owner, action.eventId, row, source, appliedAt)) linked += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER#${importId}` },
    ...santanderImportCompletionUpdate(appliedAt, { created: created.length, linked, skipped }),
  }));
  return {
    importId,
    created,
    summary: { created: created.length, linked, skipped, msiConfirmed },
  };
};

import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BatchGetCommand, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MsiPlan } from '@finance/domain';
import { eventMonthIndexKeys, msiPlanPurchaseOccurredAt, reconciliationPartition } from '@finance/ledger';
import { buildPlanFromCreateDecision, matchEvidenceLine, type EvidenceLine } from './msi-reconciliation.js';
import { InvalidAmexStatementError } from './amex-statement.js';
import { InvalidSantanderStatementError } from './santander-statement.js';
import {
  statementClaimKey,
  statementImportCompletionUpdate,
  statementMsiApplyAction,
  statementPreviewSummary,
  statementPurchaseApplyAction,
  type StatementDecision,
  type StatementPreviewRow,
  type StatementProvider,
} from './statement-reconciliation.js';
import type { TextractStatementExtraction } from './textract-document.js';
import { database, rawSourceBucketName, s3, tableName } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { isValidMonth } from '../months/monthly-plan.js';
import { allStoredEvents, toPublicEvent } from '../events/queries.js';
import { persistEventMsi } from '../events/mutations.js';

export type StatementImportEvent = {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly headers?: Record<string, string | undefined>;
};

type StatementPreviewDocument = {
  readonly accountLastFour: string;
  readonly product: string;
  readonly period: { readonly from: string; readonly to: string };
};

export const headerValue = (
  event: { readonly headers?: Record<string, string | undefined> },
  name: string,
): string | undefined => {
  if (!event.headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
};

export const requestBinaryBody = (event: {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}): Buffer | undefined => {
  if (!event.body) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
};

export const claimedStatementIdentities = async (
  provider: StatementProvider,
  identities: readonly string[],
): Promise<ReadonlySet<string>> => {
  const claimed = new Set<string>();
  for (let offset = 0; offset < identities.length; offset += 100) {
    let requestKeys: Record<string, unknown>[] = identities
      .slice(offset, offset + 100)
      .map((identity) => statementClaimKey(provider, identity));
    let attempts = 0;
    do {
      if (attempts > 0) await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempts)));
      const result = await database.send(new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: requestKeys, ProjectionExpression: 'PK' } },
      }));
      for (const item of result.Responses?.[tableName] ?? []) claimed.add(String(item.PK));
      requestKeys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
      attempts += 1;
      if (attempts >= 6 && requestKeys.length > 0) {
        throw new Error('Unable to verify statement dedupe keys after multiple attempts.');
      }
    } while (requestKeys.length > 0);
  }
  return claimed;
};

export const classifyMsiEvidenceRow = (
  line: EvidenceLine,
  events: readonly JsonObject[],
): StatementPreviewRow => {
  const match = matchEvidenceLine(line, events);
  if (match.kind === 'confirm') {
    return {
      identity: line.identity,
      kind: 'msi',
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      occurredOn: line.occurredOn,
      msi: true,
      installmentIndex: line.installmentIndex,
      installmentMonths: line.installmentMonths,
      originalAmountMinor: line.originalAmountMinor,
      status: 'matched',
      eventId: match.eventId,
      candidateEventIds: [match.eventId],
      candidates: [],
    };
  }
  if (match.kind === 'needs_decision') {
    const candidates = match.candidates.map((candidate) => ({
      id: candidate.eventId,
      merchantRaw: candidate.merchantRaw,
    }));
    return {
      identity: line.identity,
      kind: 'msi',
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      occurredOn: line.occurredOn,
      msi: true,
      installmentIndex: line.installmentIndex,
      installmentMonths: line.installmentMonths,
      originalAmountMinor: line.originalAmountMinor,
      status: 'needs_decision',
      candidateEventIds: candidates.map((candidate) => candidate.id),
      candidates,
    };
  }
  return {
    identity: line.identity,
    kind: 'msi',
    merchantRaw: line.merchantRaw,
    amountMinor: line.amountMinor,
    occurredOn: line.occurredOn,
    msi: true,
    installmentIndex: line.installmentIndex,
    installmentMonths: line.installmentMonths,
    originalAmountMinor: line.originalAmountMinor,
    status: 'skipped',
    candidateEventIds: [],
    candidates: [],
  };
};

export const statementPreviewResponse = (
  importId: string,
  document: StatementPreviewDocument,
  rows: readonly StatementPreviewRow[],
): JsonObject => ({
  importId,
  status: 'ready',
  accountLastFour: document.accountLastFour,
  product: document.product,
  period: document.period,
  summary: statementPreviewSummary(rows),
  rows,
});

export const persistTextractExtraction = async (
  sourceKey: string,
  extraction: TextractStatementExtraction,
): Promise<string> => {
  const extractionKey = sourceKey.replace(/\.pdf$/i, '.textract.json');
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: extractionKey,
    Body: JSON.stringify(extraction),
    ContentType: 'application/json; charset=utf-8',
  }));
  return extractionKey;
};

export const loadStatementTextractExtraction = async (item: JsonObject): Promise<TextractStatementExtraction> => {
  const source = item.source as JsonObject | undefined;
  const extractionKey = typeof item.extractionKey === 'string'
    ? item.extractionKey
    : typeof source?.key === 'string'
      ? source.key.replace(/\.pdf$/i, '.textract.json')
      : undefined;
  if (!extractionKey) throw new Error('Missing Textract extraction for statement import apply.');
  const object = await s3.send(new GetObjectCommand({ Bucket: rawSourceBucketName, Key: extractionKey }));
  if (!object.Body) throw new Error('Statement Textract extraction did not contain a body.');
  const parsed = JSON.parse(await object.Body.transformToString('utf8')) as TextractStatementExtraction;
  if (!parsed?.answers || !Array.isArray(parsed.tables)) {
    throw new Error('Invalid Textract extraction payload.');
  }
  return parsed;
};

const parseStatementDecisions = (body: string | undefined): Readonly<Record<string, StatementDecision>> => {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { decisions?: unknown };
    if (!parsed.decisions || typeof parsed.decisions !== 'object' || Array.isArray(parsed.decisions)) return {};
    const decisions: Record<string, StatementDecision> = {};
    for (const [identity, raw] of Object.entries(parsed.decisions as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') {
        throw new InvalidAmexStatementError('Una decisión de conciliación no es válida.');
      }
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
          throw new InvalidAmexStatementError('Falta el movimiento elegido para una conciliación MSI.');
        }
        decisions[identity] = decision.action === 'link'
          ? { action: 'link', eventId: decision.eventId }
          : { action: 'confirm_msi', eventId: decision.eventId };
        continue;
      }
      if (decision.action === 'create_plan') {
        if (!Number.isInteger(decision.months) || Number(decision.months) < 1 || Number(decision.months) > 48) {
          throw new InvalidAmexStatementError('Los meses del plan MSI no son válidos.');
        }
        if (!Number.isInteger(decision.cuotaMinor) || Number(decision.cuotaMinor) <= 0) {
          throw new InvalidAmexStatementError('La cuota del plan MSI no es válida.');
        }
        if (decision.startMonth !== undefined && (typeof decision.startMonth !== 'string' || !isValidMonth(decision.startMonth))) {
          throw new InvalidAmexStatementError('El mes de inicio del plan MSI no es válido.');
        }
        decisions[identity] = {
          action: 'create_plan',
          months: Number(decision.months),
          cuotaMinor: Number(decision.cuotaMinor),
          ...(typeof decision.startMonth === 'string' ? { startMonth: decision.startMonth } : {}),
        };
        continue;
      }
      throw new InvalidAmexStatementError('Una decisión de conciliación no es válida.');
    }
    return decisions;
  } catch (error) {
    if (error instanceof InvalidAmexStatementError) throw error;
    throw new InvalidAmexStatementError('Las decisiones de conciliación no tienen un formato válido.');
  }
};

export const claimAndCreateStatementEvent = async (input: {
  readonly provider: StatementProvider;
  readonly owner: string;
  readonly accountLastFour: string;
  readonly row: StatementPreviewRow;
  readonly source: JsonObject;
  readonly appliedAt: string;
  readonly msi?: MsiPlan;
}): Promise<JsonObject | undefined> => {
  const institution = input.provider === 'amex' ? 'american_express_mx' : 'santander_mx';
  const captureSource = input.provider === 'amex' ? 'amex_statement' : 'santander_statement';
  const parserVersion = input.provider === 'amex'
    ? 'amex-mx-statement-textract-v1'
    : 'santander-mx-statement-textract-v1';
  const id = randomUUID();
  const observationId = randomUUID();
  const evidenceOccurredAt = `${input.row.occurredOn}T12:00:00.000Z`;
  const occurredAt = msiPlanPurchaseOccurredAt(input.row.occurredOn, input.msi?.installments[0]?.month);
  const amountMinor = input.msi?.principalMinor ?? input.row.amountMinor;
  const purchase: JsonObject = {
    id,
    institution,
    eventType: 'card_purchase',
    status: input.msi?.needsScheduleCompletion ? 'needs_review' : 'accepted',
    account: {
      institution,
      accountId: `${institution}:${input.accountLastFour}`,
      displayName: input.provider === 'amex'
        ? `American Express · ${input.accountLastFour}`
        : `Santander · ${input.accountLastFour}`,
      lastFour: input.accountLastFour,
    },
    amount: { amountMinor, currency: 'MXN' },
    merchantRaw: input.row.merchantRaw,
    occurredAt,
    receivedAt: input.appliedAt,
    ingestedAt: input.appliedAt,
    source: input.source,
    parserVersion,
    parseWarnings: input.msi?.needsScheduleCompletion
      ? ['MSI sin plan completo: confirma meses y cuota.']
      : [],
    captureSource,
    captureSources: [captureSource],
    observationCount: 1,
    primaryObservationId: observationId,
    hasRawEmail: false,
    ...(input.msi ? { msi: input.msi } : {}),
  };
  const claim = statementClaimKey(input.provider, input.row.identity);
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: {
          ...claim,
          entityType: `${captureSource}_dedupe`,
          identity: input.row.identity,
          owner: input.owner,
          eventId: id,
          createdAt: input.appliedAt,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${id}`,
          SK: 'EVENT',
          GSI1PK: 'EVENTS',
          GSI1SK: input.appliedAt,
          GSI2PK: reconciliationPartition(purchase as Parameters<typeof reconciliationPartition>[0]),
          GSI2SK: `${occurredAt}#${id}`,
          ...eventMonthIndexKeys({ eventId: id, occurredAt, receivedAt: input.appliedAt }),
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
          payload: {
            id: observationId,
            eventId: id,
            captureSource,
            observedAt: input.appliedAt,
            reconciliationAt: evidenceOccurredAt,
            institution,
            eventType: 'card_purchase',
            account: purchase.account,
            amount: purchase.amount,
            merchantRaw: input.row.merchantRaw,
            occurredAt: evidenceOccurredAt,
            source: input.source,
            parserVersion,
            parseWarnings: purchase.parseWarnings,
          },
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

export const claimAndLinkStatementEvidence = async (input: {
  readonly provider: StatementProvider;
  readonly owner: string;
  readonly eventId: string;
  readonly row: StatementPreviewRow;
  readonly source: JsonObject;
  readonly appliedAt: string;
}): Promise<boolean> => {
  const institution = input.provider === 'amex' ? 'american_express_mx' : 'santander_mx';
  const captureSource = input.provider === 'amex' ? 'amex_statement' : 'santander_statement';
  const parserVersion = input.provider === 'amex'
    ? 'amex-mx-statement-textract-v1'
    : 'santander-mx-statement-textract-v1';
  const revisionId = randomUUID();
  const observationId = randomUUID();
  const reconciliationAt = `${input.row.occurredOn}T12:00:00.000Z`;
  const claim = statementClaimKey(input.provider, input.row.identity);
  try {
    await database.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: {
          ...claim,
          entityType: `${captureSource}_dedupe`,
          identity: input.row.identity,
          owner: input.owner,
          createdAt: input.appliedAt,
          eventId: input.eventId,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      } },
      { Update: {
        TableName: tableName,
        Key: { PK: `EVENT#${input.eventId}`, SK: 'EVENT' },
        UpdateExpression: 'SET #payload.#count = if_not_exists(#payload.#count, :one) + :one, #payload.#sources = list_append(if_not_exists(#payload.#sources, :empty), :source), #payload.#reconciledAt = :reconciledAt',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: {
          '#payload': 'payload',
          '#count': 'observationCount',
          '#sources': 'captureSources',
          '#reconciledAt': 'reconciledAt',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':empty': [],
          ':source': [captureSource],
          ':reconciledAt': input.appliedAt,
        },
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${input.eventId}`,
          SK: `OBSERVATION#${reconciliationAt}#${observationId}`,
          entityType: 'event_observation',
          payload: {
            id: observationId,
            eventId: input.eventId,
            captureSource,
            observedAt: input.appliedAt,
            reconciliationAt,
            institution,
            eventType: 'card_purchase',
            amount: { amountMinor: input.row.amountMinor, currency: 'MXN' },
            merchantRaw: input.row.merchantRaw,
            occurredAt: reconciliationAt,
            source: input.source,
            parserVersion,
            parseWarnings: [],
          },
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      } },
      { Put: {
        TableName: tableName,
        Item: {
          PK: `EVENT#${input.eventId}`,
          SK: `REVISION#${input.appliedAt}#${revisionId}`,
          entityType: 'event_revision',
          payload: {
            id: revisionId,
            observedPurchaseId: input.eventId,
            createdAt: input.appliedAt,
            changedBy: input.owner,
            reason: input.provider === 'amex'
              ? 'Conciliado con estado de cuenta Amex.'
              : 'Conciliado con estado de cuenta Santander.',
            changes: { reconciliation: { previous: null, next: { source: input.source, reconciledAt: input.appliedAt } } },
          },
        },
      } },
    ] }));
    return true;
  } catch (error) {
    if (errorName(error) === 'TransactionCanceledException') return false;
    throw error;
  }
};

export const applyStatementImport = async (input: {
  readonly provider: StatementProvider;
  readonly importId: string;
  readonly owner: string;
  readonly decisionBody: string | undefined;
  readonly rebuildRows: () => Promise<readonly StatementPreviewRow[]>;
}): Promise<JsonObject> => {
  const invalid = input.provider === 'amex' ? InvalidAmexStatementError : InvalidSantanderStatementError;
  const sk = input.provider === 'amex'
    ? `IMPORT#AMEX#${input.importId}`
    : `IMPORT#SANTANDER_STATEMENT#${input.importId}`;
  if (!/^[a-f0-9]{64}$/.test(input.importId)) throw new invalid('Identificador de importación inválido.');
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${input.owner}`, SK: sk },
    ConsistentRead: true,
  }));
  const source = stored.Item?.source as JsonObject | undefined;
  if (!stored.Item || stored.Item.owner !== input.owner || typeof source?.key !== 'string') {
    throw new invalid('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.Item.status === 'processing') {
    throw new invalid('El PDF aún se está leyendo. Espera a que termine Textract.');
  }
  if (stored.Item.status === 'failed') {
    throw new invalid(
      typeof stored.Item.errorMessage === 'string'
        ? stored.Item.errorMessage
        : 'No se pudo leer el estado de cuenta.',
    );
  }
  if (stored.Item.status === 'applied') {
    const previous = stored.Item.result as JsonObject | undefined;
    return {
      importId: input.importId,
      created: [],
      summary: previous ?? { created: 0, linked: 0, skipped: 0, msiConfirmed: 0, createdUnplanned: 0 },
      alreadyApplied: true,
    };
  }
  if (stored.Item.status !== 'previewed' || !Array.isArray(stored.Item.rows)) {
    throw new invalid('La previsualización aún no está lista.');
  }

  const accountLastFour = String(stored.Item.accountLastFour ?? '');
  const previewRows = stored.Item.rows as readonly StatementPreviewRow[];
  const previewByIdentity = new Map(previewRows.map((row) => [row.identity, row]));
  const decisions = parseStatementDecisions(input.decisionBody);
  const currentRows = await input.rebuildRows();
  const appliedAt = new Date().toISOString();
  let eventsSnapshot = await allStoredEvents();
  let createdCount = 0;
  let linked = 0;
  let skipped = 0;
  let msiConfirmed = 0;
  let createdUnplanned = 0;
  const created: JsonObject[] = [];

  for (const row of currentRows) {
    const preview = previewByIdentity.get(row.identity);
    if (row.kind === 'msi') {
      const evidence: EvidenceLine = {
        merchantRaw: row.merchantRaw,
        amountMinor: row.amountMinor,
        occurredOn: row.occurredOn,
        identity: row.identity,
        installmentIndex: row.installmentIndex,
        installmentMonths: row.installmentMonths,
        originalAmountMinor: row.originalAmountMinor,
      };
      const action = statementMsiApplyAction(row, preview, decisions[row.identity]);
      const msiNote = input.provider === 'amex'
        ? 'Cuota MSI confirmada con estado de cuenta Amex.'
        : 'Cuota MSI confirmada con estado de cuenta Santander.';
      if (action.kind === 'confirm_msi') {
        const match = matchEvidenceLine(
          evidence,
          eventsSnapshot.filter((event) => event.id === action.eventId),
        );
        if (match.kind !== 'confirm') {
          // Fall back to full snapshot if scoped miss (e.g. plan updated mid-apply).
          const fallback = matchEvidenceLine(evidence, eventsSnapshot);
          if (fallback.kind !== 'confirm' || fallback.eventId !== action.eventId) {
            skipped += 1;
            continue;
          }
          const updated = await persistEventMsi(fallback.eventId, input.owner, fallback.previous, fallback.next, msiNote);
          if (updated) {
            msiConfirmed += 1;
            linked += 1;
            eventsSnapshot = eventsSnapshot.map((event) => (
              event.id === fallback.eventId ? { ...event, msi: fallback.next } : event
            ));
          } else skipped += 1;
          continue;
        }
        const updated = await persistEventMsi(match.eventId, input.owner, match.previous, match.next, msiNote);
        if (updated) {
          msiConfirmed += 1;
          linked += 1;
          eventsSnapshot = eventsSnapshot.map((event) => (
            event.id === match.eventId ? { ...event, msi: match.next } : event
          ));
        } else skipped += 1;
        continue;
      }
      if (action.kind === 'create_plan') {
        // Prefer confirming an existing plan (merchant+principal) over opening a duplicate.
        const existing = matchEvidenceLine(evidence, eventsSnapshot);
        if (existing.kind === 'confirm') {
          const updated = await persistEventMsi(existing.eventId, input.owner, existing.previous, existing.next, msiNote);
          if (updated) {
            msiConfirmed += 1;
            linked += 1;
            eventsSnapshot = eventsSnapshot.map((event) => (
              event.id === existing.eventId ? { ...event, msi: existing.next } : event
            ));
          } else skipped += 1;
          continue;
        }
        if (existing.kind === 'skip') {
          skipped += 1;
          continue;
        }
        const plan = buildPlanFromCreateDecision(evidence, {
          months: action.months,
          cuotaMinor: action.cuotaMinor,
          startMonth: action.startMonth,
        });
        const purchase = await claimAndCreateStatementEvent({
          provider: input.provider,
          owner: input.owner,
          accountLastFour,
          row,
          source,
          appliedAt,
          msi: plan,
        });
        if (purchase) {
          created.push(toPublicEvent(purchase));
          createdCount += 1;
          eventsSnapshot = [...eventsSnapshot, purchase];
        } else skipped += 1;
        continue;
      }
      skipped += 1;
      continue;
    }

    const action = statementPurchaseApplyAction(row, preview, decisions[row.identity]);
    if (action.kind === 'create') {
      const purchase = await claimAndCreateStatementEvent({
        provider: input.provider,
        owner: input.owner,
        accountLastFour,
        row,
        source,
        appliedAt,
      });
      if (purchase) {
        created.push(toPublicEvent(purchase));
        createdCount += 1;
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
    } else if (action.kind === 'link') {
      if (await claimAndLinkStatementEvidence({
        provider: input.provider,
        owner: input.owner,
        eventId: action.eventId,
        row,
        source,
        appliedAt,
      })) linked += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }

  const summary = { created: createdCount, linked, skipped, msiConfirmed, createdUnplanned };
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `USER#${input.owner}`, SK: sk },
    ...statementImportCompletionUpdate(appliedAt, summary),
  }));
  return { importId: input.importId, created, summary };
};

import { createHash, randomUUID } from 'node:crypto';
import { withNativeTransaction } from '@finance/ledger/dsql-store';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { MsiPlan } from '@finance/domain';
import { msiPlanPurchaseOccurredAt } from '@finance/ledger';
import { buildPlanFromCreateDecision, matchEvidenceLine, type EvidenceLine } from './msi-reconciliation.js';
import { InvalidAmexStatementError } from './amex-statement.js';
import { InvalidSantanderStatementError } from './santander-statement.js';
import {
  statementMsiApplyAction,
  statementPreviewSummary,
  statementPurchaseApplyAction,
  type StatementDecision,
  type StatementPreviewRow,
  type StatementProvider,
} from './statement-reconciliation.js';
import type { TextractStatementExtraction } from './textract-document.js';
import { rawSourceBucketName, s3 } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { isValidMonth } from '../months/monthly-plan.js';
import { toPublicEvent } from '../events/public-event.js';
import { assertPreparedImport, bankLedgerEvents, bankPlanEvidence, bankRowPosition, claimedBankRows, createBankMovement, linkBankEvidence } from './bank-ledger.js';
import { persistEventMsi } from '../events/mutations.js';
import { readBankImport,completeBankImport,statementImportKind, type BankImportRecord } from './import-sql.js';

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
  return claimedBankRows(statementImportKind(provider), identities);
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

export const statementImportResponse = (
  record: BankImportRecord,
  processingMessage = 'Textract sigue leyendo el PDF…',
): JsonObject => {
  if (record.status === 'processing') return { importId: record.importId, status: 'processing', message: processingMessage };
  if (record.status === 'failed') {
    const invalid = record.kind === 'amex_statement' ? InvalidAmexStatementError : InvalidSantanderStatementError;
    throw new invalid(record.errorMessage ?? 'No se pudo leer el estado de cuenta.');
  }
  if (!record.accountLastFour || !record.product || !record.period) throw new Error('Missing native statement preview metadata.');
  return statementPreviewResponse(record.importId, {
    accountLastFour: record.accountLastFour, product: record.product, period: record.period,
  }, record.rows as readonly StatementPreviewRow[]);
};

export const persistTextractExtraction = async (
  sourceKey: string,
  extraction: TextractStatementExtraction,
): Promise<string> => {
  const jobHash = createHash('sha256').update(extraction.jobId).digest('hex');
  const extractionKey = sourceKey.replace(/\.pdf$/i, `.textract.${jobHash}.json`);
  try {
    await s3.send(new PutObjectCommand({
      Bucket: rawSourceBucketName,
      Key: extractionKey,
      Body: JSON.stringify(extraction),
      ContentType: 'application/json; charset=utf-8',
      IfNoneMatch: '*',
    }));
  } catch (error) {
    if (errorName(error) !== 'PreconditionFailed') throw error;
  }
  return extractionKey;
};

export const loadStatementTextractExtraction = async (item: Pick<BankImportRecord, 'source' | 'extractionKey'>): Promise<TextractStatementExtraction> => {
  const extractionKey = item.extractionKey;
  if (!extractionKey) throw new Error('Missing Textract extraction for statement import apply.');
  const object = await s3.send(new GetObjectCommand({ Bucket: item.source.bucket, Key: extractionKey }));
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

const claimAndCreateStatementEvent = async (input: {
  readonly provider: StatementProvider; readonly record: BankImportRecord;
  readonly row: StatementPreviewRow; readonly appliedAt: string; readonly msi?: MsiPlan;
}): Promise<JsonObject | undefined> => {
  const { provider, record, row, appliedAt, msi } = input;
  const institution = provider === 'amex' ? 'american_express_mx' : 'santander_mx';
  return createBankMovement({ record, row, event: {
    id: randomUUID(), institution, eventType: 'card_purchase',
    status: msi?.needsScheduleCompletion ? 'needs_review' : 'accepted',
    account: { institution, accountId: `${institution}:${record.accountLastFour}`, lastFour: record.accountLastFour,
      displayName: provider === 'amex' ? `American Express · ${record.accountLastFour}` : `Santander · ${record.accountLastFour}` },
    amount: { amountMinor: msi?.principalMinor ?? row.amountMinor, currency: 'MXN' }, merchantRaw: row.merchantRaw,
    occurredAt: msiPlanPurchaseOccurredAt(row.occurredOn, msi?.installments[0]?.month),
    receivedAt: appliedAt, ingestedAt: appliedAt, source: record.source,
    parserVersion: provider === 'amex' ? 'amex-mx-statement-textract-v1' : 'santander-mx-statement-textract-v1',
    parseWarnings: msi?.needsScheduleCompletion ? ['MSI sin plan completo: confirma meses y cuota.'] : [], ...(msi ? { msi } : {}),
  } });
};

export type StatementApplyInput = {
  readonly provider: StatementProvider; readonly importId: string; readonly owner: string;
  readonly decisionBody: string | undefined;
  readonly prepareRows: (record: BankImportRecord) => Promise<{
    readonly rebuildRows: () => Promise<readonly StatementPreviewRow[]>;
    readonly afterRows?: () => Promise<{ readonly deferredMsi: number }>;
  }>;
};

const applyStatementImportInternal = async (input: StatementApplyInput,
  prepared: BankImportRecord, work: Awaited<ReturnType<StatementApplyInput['prepareRows']>>): Promise<JsonObject> => {
  const invalid = input.provider === 'amex' ? InvalidAmexStatementError : InvalidSantanderStatementError;
  const kind=statementImportKind(input.provider);
  if (!/^[a-f0-9]{64}$/.test(input.importId)) throw new invalid('Identificador de importación inválido.');
  const stored=await readBankImport(kind,input.importId,input.owner);
  const source=stored?.source;
  if (!stored || !source) {
    throw new invalid('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.status === 'processing') {
    throw new invalid('El PDF aún se está leyendo. Espera a que termine Textract.');
  }
  if (stored.status === 'failed') {
    throw new invalid(
      typeof stored.errorMessage === 'string'
        ? stored.errorMessage
        : 'No se pudo leer el estado de cuenta.',
    );
  }
  if (stored.status === 'applied') {
    const previous = stored.result;
    return {
      importId: input.importId,
      created: [],
      summary: previous ?? { created: 0, linked: 0, skipped: 0, msiConfirmed: 0, createdUnplanned: 0 },
      alreadyApplied: true,
    };
  }
  if (stored.status !== 'previewed') {
    throw new invalid('La previsualización aún no está lista.');
  }

  assertPreparedImport(stored, prepared);
  const previewRows = stored.rows as readonly StatementPreviewRow[];
  const previewByIdentity = new Map(previewRows.map((row) => [row.identity, row]));
  const decisions = parseStatementDecisions(input.decisionBody);
  const currentRows = await work.rebuildRows();
  const appliedAt = new Date().toISOString();
  let eventsSnapshot = await bankLedgerEvents();
  let createdCount = 0;
  let linked = 0;
  let skipped = 0;
  let msiConfirmed = 0;
  let createdUnplanned = 0;
  const created: JsonObject[] = [];

  for (const row of currentRows) {
    bankRowPosition(stored, row);
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
          const updated = await persistEventMsi(fallback.eventId, input.owner, fallback.previous, fallback.next, msiNote, bankPlanEvidence(stored, row, fallback.next));
          if (updated) {
            msiConfirmed += 1;
            linked += 1;
            eventsSnapshot = eventsSnapshot.map((event) => (
              event.id === fallback.eventId ? { ...event, msi: fallback.next } : event
            ));
          } else skipped += 1;
          continue;
        }
        const updated = await persistEventMsi(match.eventId, input.owner, match.previous, match.next, msiNote, bankPlanEvidence(stored, row, match.next));
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
          const updated = await persistEventMsi(existing.eventId, input.owner, existing.previous, existing.next, msiNote, bankPlanEvidence(stored, row, existing.next));
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
          record: stored,
          row,
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
        record: stored,
        row,
        appliedAt,
      });
      if (purchase) {
        created.push(toPublicEvent(purchase));
        createdCount += 1;
        eventsSnapshot = [...eventsSnapshot, purchase];
      } else skipped += 1;
    } else if (action.kind === 'link') {
      if (await linkBankEvidence({ record: stored, row, eventId: action.eventId, appliedAt,
        parserVersion: input.provider === 'amex' ? 'amex-mx-statement-textract-v1' : 'santander-mx-statement-textract-v1',
        reason: input.provider === 'amex' ? 'Conciliado con estado de cuenta Amex.' : 'Conciliado con estado de cuenta Santander.',
      })) linked += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }

  const extra = await work.afterRows?.();
  const summary = { created: createdCount, linked, skipped, msiConfirmed, createdUnplanned, ...extra };
  await completeBankImport(kind,input.importId,input.owner,appliedAt,summary);
  return { importId: input.importId, created, summary };
};

// Load immutable evidence once; only current financial decisions repeat under OCC retry.
export const applyStatementImport = async (input: StatementApplyInput): Promise<JsonObject> => {
  const invalid = input.provider === 'amex' ? InvalidAmexStatementError : InvalidSantanderStatementError;
  if (!/^[a-f0-9]{64}$/.test(input.importId)) throw new invalid('Identificador de importación inválido.');
  const prepared = await readBankImport(statementImportKind(input.provider), input.importId, input.owner);
  if (!prepared) throw new invalid('La previsualización ya no está disponible.');
  if (prepared.status === 'applied') return { importId: input.importId, created: [], summary: prepared.result, alreadyApplied: true };
  if (prepared.status !== 'previewed') throw new invalid('La previsualización aún no está lista.');
  const work = await input.prepareRows(prepared);
  return withNativeTransaction(() => applyStatementImportInternal(input, prepared, work));
};

import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { maybeAutoAmexMsi } from '@finance/domain';
import { applicationSqlClient, withSqlTransaction } from '@finance/ledger/sql-runtime';
import {
  appendLedgerObservation, insertLedgerMovement, insertSourceClaim, readLedgerDetail,
  readSourceClaim, SourceClaimUnavailableError,
} from '@finance/ledger/native-ledger';
import {
  manualEntryFingerprint,
  manualEntrySourceKey,
  parseManualEntry,
  type ManualEntryInput,
} from './manual-entry-input.js';
import { rawSourceBucketName, s3 } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { toPublicEvent } from './public-event.js';
import type { SqlClient } from '@finance/ledger/native-ledger';

const institutionDisplayName = (institution: ManualEntryInput['institution'], lastFour?: string): string => {
  const base = institution === 'american_express_mx'
    ? 'American Express'
    : institution === 'santander_mx'
      ? 'Santander'
      : institution === 'nu_mx'
        ? 'Nu'
        : 'AWS';
  return lastFour ? `${base} terminada en ${lastFour}` : `${base} (registro manual)`;
};

const previousManualCapture = async (client: SqlClient, fingerprint: string): Promise<JsonObject | undefined> => {
  const claim = await readSourceClaim(client, 'manual', fingerprint);
  if (!claim) return undefined;
  if (claim.outcome !== 'linked' || !claim.movement_id) throw new SourceClaimUnavailableError(String(claim.outcome));
  const detail = await readLedgerDetail(client, String(claim.movement_id));
  if (!detail) throw new Error('Manual source claim has no financial record');
  return toPublicEvent(detail, detail.revisions as JsonObject[], detail.observations as JsonObject[]);
};

export const createManualEvent = async (body: string | undefined, owner: string): Promise<JsonObject> => {
  const input = parseManualEntry(body);
  const appliedAt = new Date().toISOString();
  const fingerprint = manualEntryFingerprint(owner, input);
  const existing = await previousManualCapture(applicationSqlClient(), fingerprint);
  if (existing) return existing;
  const evidenceBody = JSON.stringify({
    kind: 'manual_entry', createdAt: appliedAt, owner, institution: input.institution,
    merchantRaw: input.merchantRaw, amountMinor: input.amountMinor, currency: input.currency,
    occurredOn: input.occurredOn, occurredAt: input.occurredAt, accountLastFour: input.accountLastFour,
    note: input.note, fingerprint,
  });
  const sourceHash = createHash('sha256').update(evidenceBody, 'utf8').digest('hex');
  const source = {
    kind: 'manual_entry' as const, bucket: rawSourceBucketName,
    key: manualEntrySourceKey(owner, sourceHash), sha256: sourceHash, contentType: 'application/json' as const,
  };
  try {
    await s3.send(new PutObjectCommand({ Bucket: rawSourceBucketName, Key: source.key, Body: evidenceBody,
      ContentType: 'application/json; charset=utf-8', IfNoneMatch: '*' }));
  } catch (error) {
    if (errorName(error) !== 'PreconditionFailed') throw error;
  }
  const id = randomUUID();
  const observationId = randomUUID();
  const account = {
    institution: input.institution,
    accountId: input.accountLastFour ? `${input.institution}:manual:${input.accountLastFour}` : `${input.institution}:manual`,
    displayName: institutionDisplayName(input.institution, input.accountLastFour),
    ...(input.accountLastFour ? { lastFour: input.accountLastFour } : {}),
  };
  const autoMsi = maybeAutoAmexMsi({ institution: input.institution, amountMinor: input.amountMinor,
    occurredAt: input.occurredAt, receivedAt: appliedAt });
  const purchase = {
    id, institution: input.institution, eventType: 'card_purchase', status: 'accepted', account,
    amount: { amountMinor: input.amountMinor, currency: input.currency }, merchantRaw: input.merchantRaw,
    occurredAt: input.occurredAt, receivedAt: appliedAt, ingestedAt: appliedAt, source,
    parserVersion: 'manual-entry-v1', parseWarnings: [], ...(autoMsi ? { msi: autoMsi } : {}),
  };
  return withSqlTransaction(async client => {
    const prior = await previousManualCapture(client, fingerprint);
    if (prior) return prior;
    await insertLedgerMovement(client, purchase, observationId, input.occurredAt);
    await appendLedgerObservation(client, { id: observationId, movementId: id, captureSource: 'manual',
      observedAt: appliedAt, reconciliationAt: input.occurredAt, institution: input.institution,
      eventType: 'card_purchase', account, amount: purchase.amount, merchantRaw: input.merchantRaw,
      occurredAt: input.occurredAt, source, parserVersion: purchase.parserVersion, parseWarnings: [], note: input.note });
    await insertSourceClaim(client, { captureSource: 'manual', token: fingerprint, createdAt: appliedAt,
      movementId: id, observationId, owner, fingerprint });
    const detail = await readLedgerDetail(client, id);
    if (!detail) throw new Error('Manual capture was not created');
    return toPublicEvent(detail, detail.revisions as JsonObject[], detail.observations as JsonObject[]);
  });
};

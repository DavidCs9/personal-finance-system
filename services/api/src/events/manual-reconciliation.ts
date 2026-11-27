import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { amountsWithinTolerance, buildMsiSchedule, dayKeyInZone, financialId, FinancialPlanError, markInstallmentSpent, maybeAutoAmexMsi,
  type MsiPlan } from '@finance/domain';
import { appendLedgerObservation, insertLedgerMovement, insertLedgerRevision, insertSourceClaim,
  isLedgerMovementId, readBankCredit, readLedgerDetail, readLedgerMovements, replaceInstallmentPlan,
  setMovementStatus, type SqlClient } from '@finance/ledger/native-ledger';
import { amexMerchantsMatch, hasCompleteMsiPlanEvidence } from '../imports/msi-reconciliation.js';
import { readerPool } from './sql-reads.js';
import { institutionDisplayName, storeManualEvidence } from './manual-entry.js';
import { parseManualEntry } from './manual-entry-input.js';
import { toPublicEvent } from './public-event.js';
import { rawSourceBucketName, s3 } from '../http/clients.js';
import { errorName, type JsonObject } from '../http/response.js';
import { parsePaymentReconciliationInput, savePaymentReconciliation } from '../months/reconciliation.js';
import { readSqlPlanRecord } from '../months/sql-reads.js';

const conflict = (message: string): never => { throw new FinancialPlanError(message, 'conflict'); };
const invalid = (message: string): never => { throw new FinancialPlanError(message); };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const ACTIVE = ['accepted', 'needs_review'];
const SOURCE_KINDS = ['confirmation', 'screenshot', 'bank_app', 'receipt'] as const;
const revisionId = (operationId: string) => `manual-reconciliation:${operationId}`;
const publicDetail = (event: JsonObject) => toPublicEvent(event, event.revisions as JsonObject[], event.observations as JsonObject[]);
const dayOf = (event: JsonObject) => dayKeyInZone(new Date(String(event.occurredAt ?? event.receivedAt)));
const accountOf = (event?: JsonObject) => event?.account as JsonObject | undefined;
const amountOf = (event: JsonObject) => event.amount as JsonObject;

const parseAttachment = (value: unknown) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 1_400_000) return invalid('El adjunto PNG, JPEG o PDF admite hasta 1 MB.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > 1_048_576) return invalid('Adjunta un archivo PNG, JPEG o PDF válido.');
  const contentType = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg'
      : bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : undefined;
  if (!contentType) return invalid('Adjunta un archivo PNG, JPEG o PDF válido.');
  return { contentType, sha256: createHash('sha256').update(bytes).digest('hex') };
};

const parseFixed = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Selecciona el gasto fijo.');
  const { paymentId, expectedPayment } = value as JsonObject;
  if (typeof paymentId !== 'string' || !paymentId || paymentId.length > 128) return invalid('Selecciona el gasto fijo.');
  const parsed = parsePaymentReconciliationInput(JSON.stringify({ eventId: null, expectedEventId: null, expectedPayment }));
  return { paymentId, expectedPayment: parsed.expectedPayment };
};

const parse = (raw: JsonObject, now: Date) => {
  if (raw.action !== 'create' && raw.action !== 'link' && raw.action !== 'installment')
    return invalid('Elige registrar, vincular o confirmar una cuota.');
  const action: 'create' | 'link' | 'installment' = raw.action;
  if (raw.movementType !== 'card_purchase' && raw.movementType !== 'card_charge' && raw.movementType !== 'outgoing_transfer')
    return invalid('El tipo de movimiento no es válido.');
  const movementType = raw.movementType;
  // The source supplies a literal calendar day. The manual-entry parser supplies the ledger's date anchor.
  const input = parseManualEntry(JSON.stringify({ institution: raw.institution, occurredOn: raw.occurredOn,
    amountMinor: raw.amountMinor, merchantRaw: raw.merchantRaw, currency: raw.currency, accountLastFour: raw.accountLastFour, note: raw.note }));
  if (input.occurredOn > dayKeyInZone(now)) return invalid('La evidencia debe corresponder a actividad observada.');
  const movementId = raw.movementId;
  if (action !== 'create' && (typeof movementId !== 'string' || !isLedgerMovementId(movementId)))
    return invalid('Selecciona el movimiento que corresponde a esta evidencia.');
  if (action === 'create' && movementId !== undefined)
    return invalid('Para vincular evidencia selecciona la acción Vincular.');
  const index = raw.installmentIndex;
  if (action !== 'installment' && index !== undefined) return invalid('El número de cuota corresponde a un plan existente.');
  if (action === 'installment' && (movementType !== 'card_purchase' || typeof index !== 'number'
    || !Number.isInteger(index) || index < 1 || index > 48))
    return invalid('Selecciona una cuota MSI válida.');
  if (!SOURCE_KINDS.some(kind => kind === raw.evidenceKind)) return invalid('Selecciona la fuente de la evidencia.');
  const reference = raw.evidenceReference;
  if (reference !== undefined && (typeof reference !== 'string' || reference.trim().length > 300))
    return invalid('La referencia de evidencia permite hasta 300 caracteres.');
  const fixed = parseFixed(raw.fixedPayment);
  if (fixed && action === 'installment')
    return invalid('Un gasto fijo requiere un cobro sin MSI.');
  let newPlan: { months: number; principalMinor: number } | undefined;
  if (raw.newPlan !== undefined) {
    if (action !== 'create' || movementType !== 'card_purchase' || fixed || !input.accountLastFour
      || !raw.newPlan || typeof raw.newPlan !== 'object' || Array.isArray(raw.newPlan))
      return invalid('Para abrir un plan registra la primera cuota e indica la tarjeta.');
    const { months, principalMinor } = raw.newPlan as JsonObject;
    if (typeof months !== 'number' || typeof principalMinor !== 'number'
      || !hasCompleteMsiPlanEvidence({ ...input, identity: '', installmentIndex: 1, installmentMonths: months, originalAmountMinor: principalMinor }))
      return invalid('Revisa el principal, la primera cuota y el número total de mensualidades.');
    newPlan = { months, principalMinor };
  }
  return { ...input, action, movementType, movementId: movementId as string | undefined,
    installmentIndex: typeof index === 'number' ? index : undefined,
    evidenceKind: String(raw.evidenceKind), evidenceReference: (reference as string | undefined)?.trim() || undefined,
    distinct: raw.distinct === true, attachment: parseAttachment(raw.attachmentBase64), fixed, newPlan };
};

type Input = ReturnType<typeof parse>;

const evidenceKey = (input: Input) => hash([input.action, input.movementType, input.occurredOn,
  input.amountMinor, input.evidenceKind, input.evidenceReference, input.attachment?.sha256]);

const resolve = async (client: SqlClient, input: Input) => {
  const candidates = input.action === 'create'
    ? (await readLedgerMovements(client, { months: [input.occurredOn.slice(0, 7)] })).filter(event =>
      event.institution === input.institution
      && amountOf(event).currency === 'MXN'
      && (dayOf(event) === input.occurredOn || input.newPlan && (
        (event.msi as MsiPlan | undefined)?.installments[0]?.month === input.occurredOn.slice(0, 7)
        || amountsWithinTolerance(Number(amountOf(event).amountMinor), input.newPlan.principalMinor)))
      && (!accountOf(event)?.lastFour || !input.accountLastFour || accountOf(event)?.lastFour === input.accountLastFour)
      && amexMerchantsMatch(String(event.merchantRaw), input.merchantRaw))
    : [];
  if (input.action === 'create') return { candidates, event: undefined, plan: undefined, installment: undefined };
  const event = await readLedgerDetail(client, input.movementId!);
  if (!event || !ACTIVE.includes(String(event.status))) return conflict('El movimiento ya no está disponible para conciliar.');
  const card = accountOf(event)?.lastFour;
  if (event.institution !== input.institution || event.eventType !== input.movementType || amountOf(event).currency !== 'MXN'
    || (card && input.accountLastFour && card !== input.accountLastFour))
    return conflict('La cuenta, moneda o tipo de movimiento difieren de la evidencia.');
  const plan = event.msi as MsiPlan | undefined;
  if (input.action === 'link') {
    const history = event.revisions as JsonObject[];
    const repeatedEvidence = history.some(revision => {
      const previous = (revision.changes as JsonObject).manualReconciliation as { next?: { evidenceKey?: string } } | undefined;
      return previous?.next?.evidenceKey === evidenceKey(input)
        && !history.some(item => item.id === `${revision.id}:undo`);
    });
    if (repeatedEvidence) return conflict('Esta evidencia ya está vinculada al movimiento.');
    if (plan || amountOf(event).amountMinor !== input.amountMinor || dayOf(event) !== input.occurredOn)
      return conflict('Confirma que coincidan el día y el importe bruto. Para MSI selecciona la cuota.');
    return { event, candidates, plan: undefined, installment: undefined };
  }
  const knownCards = new Set((event.observations as JsonObject[]).flatMap(observation => {
    const observationId = `manual:${observation.id}`;
    const lastFour = accountOf(observation)?.lastFour;
    return typeof lastFour === 'string' && plan?.installments.some(item => item.evidenceObservationId === observationId) ? [lastFour] : [];
  }));
  if (!card) {
    const imported = (await client.query(`SELECT DISTINCT header.account_last_four FROM olbia.installment_entries entry
      JOIN olbia.bank_imports header ON header.kind=entry.evidence_import_kind
        AND header.content_sha256=entry.evidence_content_sha256
      WHERE entry.movement_id=$1 AND header.account_last_four IS NOT NULL`, [input.movementId])).rows;
    for (const row of imported) if (typeof row.account_last_four === 'string') knownCards.add(row.account_last_four);
  }
  if (knownCards.size > 1 || input.accountLastFour && knownCards.size && !knownCards.has(input.accountLastFour))
    return conflict('La tarjeta contradice la evidencia de otra cuota del mismo plan.');
  if (!card && !input.accountLastFour && !knownCards.size)
    return conflict('Indica los últimos cuatro dígitos observados para verificar esta cuota con el banco.');
  const installment = plan?.installments.find(item => item.index === input.installmentIndex);
  if (!plan || plan.needsScheduleCompletion || !installment || installment.status !== 'committed'
    || installment.month !== input.occurredOn.slice(0, 7) || !amountsWithinTolerance(installment.amountMinor, input.amountMinor))
    return conflict('La cuota debe estar comprometida, corresponder al mes y coincidir con el importe programado dentro de $2.00 MXN.');
  return { event, candidates, plan, installment };
};

export const prepareManualReconciliation = async (client: SqlClient, owner: string, input: Input) => {
  const resolution = await resolve(client, input);
  const { candidates, event, installment } = resolution;
  const candidateDetails = candidates.map(item => ({ id: item.id, status: item.status,
    merchantRaw: item.merchantRaw, amount: item.amount, movementType: item.eventType, accountLastFour: accountOf(item)?.lastFour }));
  const evidence = { kind: input.evidenceKind, reference: input.evidenceReference, note: input.note,
    occurredOn: input.occurredOn, amountMinor: input.amountMinor, merchantRaw: input.merchantRaw,
    institution: input.institution, accountLastFour: input.accountLastFour, movementType: input.movementType, newPlan: input.newPlan };
  const month = input.occurredOn.slice(0, 7);
  const payment = input.fixed && (await readSqlPlanRecord(owner, month, client))?.upcomingPayments.find(item =>
    item.id === input.fixed?.paymentId);
  if (input.fixed && (!payment || payment.reconciliation
    || payment.name !== input.fixed.expectedPayment.name || payment.amountMinor !== input.fixed.expectedPayment.amountMinor
    || payment.dueDay !== input.fixed.expectedPayment.dueDay
    || (input.action === 'create' && input.movementType === 'card_purchase' && maybeAutoAmexMsi({ ...input, receivedAt: input.occurredAt }))))
    return conflict('La programación cambió, ya tiene vínculo o el cobro generaría MSI.');
  const state = event ? { id: event.id, amount: event.amount, account: event.account, status: event.status,
    occurredAt: event.occurredAt, plan: event.msi, observationCount: event.observationCount } : candidateDetails;
  return { resolution, preview: { previewToken: hash([owner, input, state, payment]), candidates: candidateDetails,
    canApply: input.action !== 'create' || !candidates.length || input.distinct,
    action: input.action, evidence, movementId: event?.id, expectedAmountMinor: installment?.amountMinor ?? (event && amountOf(event).amountMinor),
    installment, newPlan: input.newPlan, fixedPayment: payment, attachment: input.attachment } };
};

export const normalizeManualReconciliation = async (owner: string, input: JsonObject, now: Date) => {
  if (input.action === 'undo_credit') return { action: 'undo_credit' as const, movementId: financialId(input.movementId) };
  if (input.action === 'undo') return { action: 'undo' as const,
    movementId: financialId(input.movementId), originalOperationId: financialId(input.originalOperationId) };
  const normalized = parse(input, now);
  if (normalized.attachment) {
    const key = `manual-entries/${owner}/attachments/${normalized.attachment.sha256}`;
    try {
      await s3.send(new PutObjectCommand({ Bucket: rawSourceBucketName, Key: key,
        Body: Buffer.from(String(input.attachmentBase64), 'base64'), ContentType: normalized.attachment.contentType,
        ChecksumSHA256: Buffer.from(normalized.attachment.sha256, 'hex').toString('base64'), IfNoneMatch: '*' }));
    } catch (error) {
      if (errorName(error) !== 'PreconditionFailed') throw error;
    }
  }
  return normalized;
};

export type ManualReconciliation = Awaited<ReturnType<typeof normalizeManualReconciliation>>;

export const manualReconciliationProposal = async (client: SqlClient, owner: string, input: ManualReconciliation) => {
  if (input.action === 'undo_credit') {
    const credit = await reversibleCredit(client, owner, input.movementId);
    return { token: hash(credit), canApply: true, action: input.action, movementId: input.movementId, credit };
  }
  if (input.action === 'undo') {
    const target = await reversibleManualReconciliation(client, owner, input.movementId, input.originalOperationId);
    return { token: hash(target.snapshot), canApply: true, action: input.action, movementId: input.movementId,
      originalOperationId: input.originalOperationId };
  }
  const { preview } = await prepareManualReconciliation(client, owner, input);
  const { previewToken: token, ...details } = preview;
  return { token, ...details };
};

export const prepareManualReconciliationApply = async (owner: string, input: ManualReconciliation,
  identity: { movementId: string; operationId: string }, expectedToken: unknown) => {
  if (input.action === 'undo_credit') return async (client: SqlClient, at: string) => {
    const credit = await reversibleCredit(client, owner, input.movementId);
    if (hash(credit) !== expectedToken) return conflict('El abono cambió. Vuelve a revisarlo.');
    await setMovementStatus(client, input.movementId, 'rejected');
    await insertLedgerRevision(client, { id: revisionId(identity.operationId), movementId: input.movementId, changedBy: owner,
      createdAt: at, source: 'manual_reconciliation', changes: { status: { previous: 'accepted', next: 'rejected' } } });
    return { id: input.movementId, status: 'rejected', credit };
  };
  if (input.action === 'undo') return async (client: SqlClient, at: string) => {
    const target = await reversibleManualReconciliation(client, owner, input.movementId, input.originalOperationId);
    if (hash(target.snapshot) !== expectedToken) return conflict('La conciliación cambió. Vuelve a revisar antes de deshacer.');
    return undoManualReconciliation(client, owner, input.movementId, input.originalOperationId, target, at);
  };
  const { operationId } = identity;
  const source = { ...await storeManualEvidence(owner, JSON.stringify({ owner, operationId, evidence: input })),
    evidenceKind: input.evidenceKind, evidenceReference: input.evidenceReference, occurredOn: input.occurredOn,
    attachment: input.attachment };
  const account = {
    institution: input.institution,
    accountId: `${input.institution}:manual${input.accountLastFour ? `:${input.accountLastFour}` : ''}`,
    displayName: institutionDisplayName(input.institution, input.accountLastFour),
    ...(input.accountLastFour ? { lastFour: input.accountLastFour } : {}),
  };
  const id = identity.movementId;
  const amount = { amountMinor: input.amountMinor, currency: input.currency };
  return async (client: SqlClient, at: string) => {
    const current = await prepareManualReconciliation(client, owner, input);
    if (!current.preview.canApply || current.preview.previewToken !== expectedToken)
      return conflict('La conciliación cambió. Revisa las coincidencias antes de guardar.');
    const newPlan = input.newPlan && buildMsiSchedule({ principalMinor: input.newPlan.principalMinor,
      months: input.newPlan.months, cuotaMinor: input.amountMinor, startMonth: input.occurredOn.slice(0, 7), origin: 'manual' });
    const plan = current.resolution.plan ?? newPlan;
    const installment = current.resolution.installment ?? newPlan?.installments[0];
    const parserVersion = 'manual-reconciliation-v1';
    if (input.action === 'create') {
      const msi = newPlan ?? (input.movementType === 'card_purchase' ? maybeAutoAmexMsi({ ...input, receivedAt: at }) : undefined);
      const movementAmount = newPlan ? { ...amount, amountMinor: newPlan.principalMinor } : amount;
      await insertLedgerMovement(client, { id, institution: input.institution, eventType: input.movementType,
        status: 'accepted', account, amount: movementAmount, merchantRaw: input.merchantRaw, occurredAt: input.occurredAt,
        receivedAt: at, ingestedAt: at, source, parserVersion, parseWarnings: [], ...(msi ? { msi } : {}) },
      operationId, input.occurredAt);
    }
    await appendLedgerObservation(client, { id: operationId, movementId: id, captureSource: 'manual', observedAt: at,
      reconciliationAt: input.occurredAt, institution: input.institution, eventType: input.movementType, amount,
      merchantRaw: input.merchantRaw, account, source, parserVersion, parseWarnings: [], note: input.note });
    const changes: Record<string, { previous: unknown; next: unknown }> = {
      manualReconciliation: { previous: null, next: { action: input.action, observationId: operationId, evidenceKey: evidenceKey(input) } },
    };
    if (plan && installment) {
      const next = { ...markInstallmentSpent(plan, installment.index, { amountMinor: input.amountMinor,
        occurredOn: input.occurredOn, confirmedAt: at, evidenceObservationId: `manual:${operationId}` }), cuotaMinor: plan.cuotaMinor };
      await replaceInstallmentPlan(client, id, next, [], operationId);
      changes.msi = { previous: installment, next: next.installments[installment.index - 1] };
    }
    if (input.fixed) {
      const month = input.occurredOn.slice(0, 7);
      await savePaymentReconciliation(owner, month, input.fixed.paymentId, {
        expectedPayment: input.fixed.expectedPayment, expectedEventId: null, eventId: id,
      });
      const link = (await client.query('SELECT linked_at FROM olbia.planned_payment_charges WHERE month=$1 AND payment_id=$2',
        [month, input.fixed.paymentId])).rows[0];
      changes.fixedPayment = { previous: null, next: { ...input.fixed, month, linkedAt: new Date(String(link.linked_at)).toISOString() } };
    }
    await insertLedgerRevision(client, { id: revisionId(operationId), movementId: id, createdAt: at, changedBy: owner,
      source: 'manual_reconciliation', changes });
    await insertSourceClaim(client, { captureSource: 'manual', token: hash([owner, operationId]), owner, movementId: id,
      observationId: operationId, createdAt: at, reconciled: input.action !== 'create' });
    return publicDetail((await readLedgerDetail(client, id))!);
  };
};

const reversibleCredit = async (client: SqlClient, owner: string, movementId: string) => {
  const credit = await readBankCredit(client, owner, movementId);
  if (!credit || credit.creditType === 'fund_release') return conflict('No se encontró un abono reversible.');
  if ((await client.query("SELECT 1 FROM olbia.ledger_observations WHERE movement_id=$1 AND capture_source<>'manual'",
    [movementId])).rows.length) return conflict('El banco ya verificó el abono.');
  return credit;
};

type ManualRevisionChanges = {
  manualReconciliation: { next: { action: Input['action'] } };
  fixedPayment?: { next: NonNullable<Input['fixed']> & { month: string; linkedAt: string } };
  msi?: { previous: MsiPlan['installments'][number]; next: MsiPlan['installments'][number] };
};

const reversibleManualReconciliation = async (client: SqlClient, owner: string, movementId: string, operationId: string) => {
  const event = await readLedgerDetail(client, movementId);
  const history = (event?.revisions ?? []) as JsonObject[];
  const revision = history.find(item => item.id === revisionId(operationId) && item.changedBy === owner);
  if (!event || !revision) return conflict('No se encontró esa conciliación.');
  if (history.some(item => item.id === `${revisionId(operationId)}:undo`)) return conflict('La conciliación ya fue revertida.');
  const changes = revision.changes as ManualRevisionChanges;
  const plan = event.msi as MsiPlan | undefined;
  const current = plan?.installments.find(item => item.index === changes.msi?.next.index);
  if (changes.msi && (!plan || !current || plan.status === 'cancelled' || current.month !== changes.msi.next.month
    || current.evidenceObservationId !== `manual:${operationId}`
    || current.amountMinor !== changes.msi.next.amountMinor || current.occurredOn !== changes.msi.next.occurredOn))
    return conflict('La cuota cambió o el banco ya la verificó.');
  const fixed = changes.fixedPayment?.next;
  const links = (await client.query('SELECT month, payment_id, linked_at FROM olbia.planned_payment_charges WHERE movement_id=$1', [movementId])).rows;
  if (fixed && !links.some(link => link.month === fixed.month && link.payment_id === fixed.paymentId
    && new Date(String(link.linked_at)).toISOString() === fixed.linkedAt)) return conflict('El vínculo de gasto fijo cambió.');
  if (changes.manualReconciliation.next.action === 'create'
    && (Number(event.observationCount) !== 1 || history.length !== 1 || links.length !== Number(Boolean(fixed))))
    return conflict('El movimiento tiene evidencia, vínculos o cambios posteriores.');
  return { event, changes, plan, fixed, snapshot: { status: event.status, plan, history, links, observationCount: event.observationCount } };
};

const undoManualReconciliation = async (client: SqlClient, owner: string, movementId: string, operationId: string,
  target: Awaited<ReturnType<typeof reversibleManualReconciliation>>, at: string) => {
  const { event, changes, plan, fixed } = target;
  if (plan && changes.msi) {
    const { previous, next } = changes.msi;
    await replaceInstallmentPlan(client, movementId, { ...plan, status: 'active',
      installments: plan.installments.map(item => item.index === next.index ? previous : item) });
  }
  if (fixed) await savePaymentReconciliation(owner, fixed.month, fixed.paymentId, {
    expectedPayment: fixed.expectedPayment, expectedEventId: movementId, eventId: null,
  });
  if (changes.manualReconciliation.next.action === 'create') await setMovementStatus(client, movementId, 'rejected');
  await insertLedgerRevision(client, { id: `${revisionId(operationId)}:undo`, movementId, createdAt: at, changedBy: owner,
    source: 'manual_reconciliation', changes: { manualReconciliation: { previous: operationId, next: null },
      ...(fixed ? { fixedPayment: { previous: fixed, next: null } } : {}),
      ...(changes.msi ? { msi: { previous: changes.msi.next, next: changes.msi.previous } } : {}),
      ...(changes.manualReconciliation.next.action === 'create' ? { status: { previous: event.status, next: 'rejected' } } : {}) } });
  return publicDetail((await readLedgerDetail(client, movementId))!);
};

/** Resolve the owner and exact attachment from the claimed observation, never from a client storage pointer. */
export const getManualReconciliationAttachment = async (owner: string, movementId: string, operationId: string) => {
  if (!isLedgerMovementId(movementId) || !isLedgerMovementId(operationId)) return undefined;
  const row = (await readerPool().query(`SELECT o.source_metadata->'attachment' AS attachment FROM olbia.source_claims c
    JOIN olbia.ledger_observations o ON o.id=c.observation_id AND o.movement_id=c.movement_id
    WHERE c.capture_source='manual' AND c.owner=$1 AND c.movement_id=$2 AND c.observation_id=$3`,
  [owner, movementId, operationId])).rows[0];
  const attachment = row?.attachment as { sha256?: string; contentType?: string } | undefined;
  if (!attachment?.sha256 || !/^[a-f0-9]{64}$/.test(attachment.sha256)) return undefined;
  const key = `manual-entries/${owner}/attachments/${attachment.sha256}`;
  const extension = attachment.contentType === 'image/png' ? 'png' : attachment.contentType === 'application/pdf' ? 'pdf' : 'jpg';
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: rawSourceBucketName, Key: key,
    ResponseContentDisposition: `attachment; filename="evidencia.${extension}"` }), { expiresIn: 600 });
  return { url };
};

import { randomUUID } from 'node:crypto';
import type { MsiPlan } from '@finance/domain';
import { msiPlanPurchaseOccurredAt } from '@finance/ledger';
import { parseAmexActivity, InvalidAmexActivityError, type AmexActivityDocument } from './amex-activity.js';
import { activitySource, loadAmexActivitySource, parseActivityUpload } from './amex-activity-source.js';
import { classifyAmexRows, readAmexRetainedRows, scopedAmexEvents, selectedAmexMsi } from './amex-reconciliation.js';
import { buildPlanFromCreateDecision, matchEvidenceLine } from './msi-reconciliation.js';
import { assertPreparedImport, bankLedgerEvents, bankPlanEvidence, bankRowPosition, claimedBankRows,
  createBankMovement, linkBankEvidence, withBankApplyTransaction } from './bank-ledger.js';
import { readBankImport, startBankImport, completeBankImport, type BankImportRecord, type BankImportRow } from './import-sql.js';
import { parseStatementDecisions } from './statement-shared.js';
import { statementPreviewSummary, type StatementPreviewRow } from './statement-reconciliation.js';
import { persistEventMsi } from '../events/mutations.js';
import { toPublicEvent } from '../events/public-event.js';
import type { JsonObject } from '../http/response.js';

const classify = async (document: AmexActivityDocument, owner: string) => {
  const [events, retained, claimed] = await Promise.all([bankLedgerEvents(), readAmexRetainedRows(owner),
    claimedBankRows('amex_activity', document.rows.map(r => r.identity))]);
  return classifyAmexRows({ sourceKind: 'amex_activity', ...document, events, retained, claimed });
};
const response = (record: BankImportRecord) => ({ importId: record.importId, status: 'ready', accountLastFour: record.accountLastFour,
  product: record.product, period: record.period, rows: record.rows, summary: statementPreviewSummary(record.rows as readonly StatementPreviewRow[]),
  alreadyApplied: record.status === 'applied' });

export const previewAmexActivity = async (body: string | undefined, owner: string) => {
  const input = parseActivityUpload(body);
  const bytes = await loadAmexActivitySource(owner, input.sha256, input.size);
  const document = await parseAmexActivity(bytes);
  const existing = await readBankImport('amex_activity', input.sha256, owner);
  if (existing?.status === 'applied') return response(existing);
  const rows = await classify(document, owner);
  const now = new Date().toISOString();
  const record=await startBankImport({ kind: 'amex_activity', importId: input.sha256, owner, status: 'previewed',
    createdAt: now, previewedAt: now, source: activitySource(owner, input.sha256), accountLastFour: document.accountLastFour,
    product: document.product, period: document.period, rows });
  return response(record.status==='previewed'?{...record,rows}:record);
};

const create = (record: BankImportRecord, row: BankImportRow, at: string, msi?: MsiPlan) => createBankMovement({ record, row, event: {
  id: randomUUID(), institution: 'american_express_mx', eventType: 'card_purchase', status: 'accepted',
  account: { institution: 'american_express_mx', accountId: `american_express_mx:${record.accountLastFour}`,
    lastFour: record.accountLastFour, displayName: `American Express · ${record.accountLastFour}` },
  amount: { amountMinor: msi?.principalMinor ?? row.amountMinor, currency: 'MXN' }, merchantRaw: row.merchantRaw,
  bankTransactionId: row.transactionId, occurredAt: msiPlanPurchaseOccurredAt(row.occurredOn, msi?.installments[0]?.month),
  receivedAt: at, ingestedAt: at, source: record.source, parserVersion: 'amex-mx-activity-xlsx-v1', parseWarnings: [], ...(msi ? { msi } : {}),
} });
const stale = (): never => { throw new InvalidAmexActivityError('Los movimientos cambiaron. Vuelve a revisar el Excel antes de aplicar; no se guardó el lote.'); };

export const applyAmexActivity = async (importId: string, owner: string, body: string | undefined): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) throw new InvalidAmexActivityError('Identificador de importación inválido.');
  const prepared = await readBankImport('amex_activity', importId, owner);
  if (!prepared) throw new InvalidAmexActivityError('Vuelve a seleccionar el Excel para revisar la importación.');
  if (prepared.status === 'applied') return { importId, created: [], summary: prepared.result, alreadyApplied: true };
  if (prepared.status !== 'previewed') return stale();
  // Source IO and parsing happen once, outside the retryable SQL transaction.
  const document = await parseAmexActivity(await loadAmexActivitySource(owner, importId));
  const decisions = parseStatementDecisions(body);
  return withBankApplyTransaction(async () => {
    const record = await readBankImport('amex_activity', importId, owner);
    if (!record) return stale();
    if (record.status === 'applied') return { importId, created: [], summary: record.result, alreadyApplied: true };
    assertPreparedImport(record, prepared);
    const rows = await classify(document, owner);
    let events = scopedAmexEvents(await bankLedgerEvents(), document.accountLastFour);
    const created: JsonObject[] = [];
    let linked = 0, skipped = 0, msiConfirmed = 0;
    const usedTargets = new Set<string>(), createdIds = new Set<string>();
    for (const row of rows) {
      bankRowPosition(record, row);
      if (row.status === 'duplicate' || row.status === 'excluded') { skipped++; continue; }
      const preview = record.rows.find(p => p.identity === row.identity);
      if (!preview || preview.status !== row.status || preview.candidateEventIds.join() !== row.candidateEventIds.join()) return stale();
      const decision = decisions[row.identity];
      if (decision?.action === 'skip') { skipped++; continue; }
      if (row.kind === 'msi') {
        const eventId = row.status === 'matched' ? row.eventId
          : decision?.action === 'confirm_msi' || decision?.action === 'link' ? decision.eventId : undefined;
        if (eventId) {
          if (!row.candidateEventIds.includes(eventId) || usedTargets.has(`${eventId}:${row.installmentIndex}`)) return stale();
          const event = events.find(e => e.id === eventId);
          if (!event) return stale();
          const match = selectedAmexMsi(row, event);
          if (match.kind !== 'confirm' || match.eventId !== eventId) return stale();
          if (!await persistEventMsi(eventId, owner, match.previous, match.next, 'Cuota MSI confirmada con actividad Amex.', bankPlanEvidence(record, row, match.next))) return stale();
          if (!await linkBankEvidence({ record, row, eventId, appliedAt: new Date().toISOString(),
            parserVersion: 'amex-mx-activity-xlsx-v1', reason: 'Actividad Amex vinculada al plan existente.' })) return stale();
          events = events.map(e => e.id === eventId ? { ...e, msi: match.next } : e);
          usedTargets.add(`${eventId}:${row.installmentIndex}`); msiConfirmed++; linked++; continue;
        }
        // Never manufacture a second plan while any possible owner still exists.
        if (decision?.action !== 'create_plan' || row.candidateEventIds.length
          || decision.months !== row.installmentMonths || decision.cuotaMinor !== row.amountMinor) return stale();
        const current = matchEvidenceLine(row, events.filter(e => !createdIds.has(String(e.id))));
        if (current.kind !== 'needs_decision' || current.candidates.length) return stale();
        const plan = buildPlanFromCreateDecision(row, { months: decision.months, cuotaMinor: decision.cuotaMinor });
        const movement = await create(record, row, new Date().toISOString(), plan);
        if (!movement) return stale();
        events = [...events, movement]; createdIds.add(String(movement.id)); created.push(toPublicEvent(movement)); msiConfirmed++; continue;
      }
      const eventId = row.status === 'matched' ? row.eventId : decision?.action === 'link' ? decision.eventId : undefined;
      if (eventId) {
        if (!row.candidateEventIds.includes(eventId) || usedTargets.has(eventId)) return stale();
        if (!await linkBankEvidence({ record, row, eventId, appliedAt: new Date().toISOString(), parserVersion: 'amex-mx-activity-xlsx-v1',
          reason: 'Conciliado con actividad Amex.' })) return stale();
        usedTargets.add(eventId); linked++; continue;
      }
      if (row.status !== 'new' && decision?.action !== 'create') return stale();
      const movement = await create(record, row, new Date().toISOString());
      if (!movement) return stale();
      events = [...events, movement]; created.push(toPublicEvent(movement));
    }
    const summary = { created: created.length, linked, skipped, msiConfirmed, createdUnplanned: 0 };
    await completeBankImport('amex_activity', importId, owner, new Date().toISOString(), summary);
    return { importId, created, summary };
  });
};

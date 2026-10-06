import { resolveStatementSource } from './statement-upload.js';
import { readBankImport, startBankImport, saveStatementPreview, failBankImport, type BankImportRecord } from './import-sql.js';
import { findDeferralPurchaseSubset } from './amex-deferral.js';
import {
  amexMsiEvidenceLines,
  InvalidAmexStatementError,
  parseAmexStatementExtraction,
  type AmexStatementDocument,
} from './amex-statement.js';
import {
  classifyPurchaseCharge,
  type StatementPreviewRow,
} from './statement-reconciliation.js';
import {
  fetchTextractStatementExtraction,
  getTextractAnalysisJobStatus,
  startTextractDocumentAnalysis,
  TextractDocumentError,
} from './textract-document.js';
import {
  applyStatementImport,
  claimedStatementIdentities,
  classifyMsiEvidenceRow,
  loadStatementTextractExtraction,
  persistTextractExtraction,
  statementImportResponse,
  type StatementImportEvent,
} from './statement-shared.js';
import { rawSourceBucketName, textract } from '../http/clients.js';
import { type JsonObject } from '../http/response.js';
import { localDate } from '../events/queries.js';
import { bankLedgerEvents } from './bank-ledger.js';
import { markDeferredMsi } from '../events/mutations.js';

const buildAmexPreviewRows = async (
  document: AmexStatementDocument,
): Promise<readonly StatementPreviewRow[]> => {
  const events = await bankLedgerEvents();
  const purchaseCharges = document.charges.filter((charge) => !charge.msi);
  const claimed = await claimedStatementIdentities(
    'amex',
    purchaseCharges.map((charge) => charge.identity),
  );
  const purchaseRows = purchaseCharges.map((charge) => classifyPurchaseCharge({
    provider: 'amex',
    accountLastFour: document.accountLastFour,
    institution: 'american_express_mx',
    charge,
    events,
    claimed,
    localDate,
  }));

  const msiRows = amexMsiEvidenceLines(document).map((line) => classifyMsiEvidenceRow(line, events));
  return [...purchaseRows, ...msiRows];
};

export const previewAmexImport = async (
  event: StatementImportEvent,
  owner: string,
): Promise<JsonObject> => {
  const source = await resolveStatementSource('amex', owner, event);
  const sha256 = source.sha256;
  const existing = await readBankImport('amex_statement', sha256, owner);
  if (existing?.status === 'applied' || existing?.status === 'processing') return statementImportResponse(existing);
  const textractJobId = await startTextractDocumentAnalysis(
    textract,
    rawSourceBucketName,
    source.key,
    'amex',
    existing?.textractJobId,
  );
  const saved = await startBankImport({
    kind: 'amex_statement', importId: sha256, owner, status: 'processing',
    createdAt: new Date().toISOString(), source, textractJobId, rows: [],
  });
  return statementImportResponse(saved, 'Leyendo el PDF con Textract. Consulta el estado en unos segundos.');
};

export const getAmexImport = async (importId: string, owner: string): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) throw new InvalidAmexStatementError('Identificador de importación inválido.');
  const stored = await readBankImport('amex_statement', importId, owner);
  if (!stored) throw new InvalidAmexStatementError('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  if (stored.status !== 'processing') return statementImportResponse(stored);
  const jobId = stored.textractJobId;
  if (!jobId) throw new Error('Missing native statement Textract job.');
  let job;
  try { job = await getTextractAnalysisJobStatus(textract, jobId); }
  catch (error) {
    if (!(error instanceof TextractDocumentError)) throw error;
    const current = await failBankImport('amex_statement', importId, owner, jobId, error.message);
    if (current.status !== 'failed' || current.textractJobId !== jobId) return statementImportResponse(current);
    throw error;
  }
  if (job.status === 'IN_PROGRESS') return statementImportResponse(stored);
  if (job.status === 'FAILED') {
    const message = job.statusMessage ?? 'Textract falló al leer el PDF.';
    const current = await failBankImport('amex_statement', importId, owner, jobId, message);
    if (current.status !== 'failed' || current.textractJobId !== jobId) return statementImportResponse(current);
    throw new TextractDocumentError(message);
  }

  let extractionKey: string | undefined;
  let answers: Readonly<Record<string, string>> = {};
  let preview: Pick<BankImportRecord, 'accountLastFour' | 'product' | 'period' | 'rows' | 'extractionKey' | 'textractAnswers'>;
  try {
    const extraction = await fetchTextractStatementExtraction(textract, jobId, 'amex');
    extractionKey = await persistTextractExtraction(stored.source.key, extraction);
    const retained = await loadStatementTextractExtraction({source: stored.source, extractionKey});
    answers = retained.answers;
    const document = parseAmexStatementExtraction(retained);
    const rows = await buildAmexPreviewRows(document);
    preview = { accountLastFour: document.accountLastFour, product: document.product,
      period: document.period, rows, extractionKey, textractAnswers: answers };
  } catch (error) {
    // Transient storage/query failures leave processing retryable; only document failures end the job.
    if (!(error instanceof InvalidAmexStatementError) && !(error instanceof TextractDocumentError)) throw error;
    const current = await failBankImport('amex_statement', importId, owner, jobId, error.message,
      extractionKey ? { extractionKey, textractAnswers: answers } : {});
    if (current.status !== 'failed' || current.textractJobId !== jobId) return statementImportResponse(current);
    throw error;
  }
  const current = await saveStatementPreview('amex_statement', importId, owner, jobId, preview);
  return statementImportResponse(current);
};

export const applyAmexImport = async (importId: string, owner: string, decisionBody: string | undefined): Promise<JsonObject> =>
  applyStatementImport({ provider: 'amex', importId, owner, decisionBody,
    prepareRows: async (stored) => {
      const document = parseAmexStatementExtraction(await loadStatementTextractExtraction(stored));
      return { rebuildRows: () => buildAmexPreviewRows(document), afterRows: async () => ({
        deferredMsi: await applyAmexDeferralCredits({ owner, accountLastFour: document.accountLastFour, deferralCredits: document.deferralCredits }),
      }) };
    },
  });

const applyAmexDeferralCredits = async (input: {
  readonly owner: string;
  readonly accountLastFour: string;
  readonly deferralCredits: AmexStatementDocument['deferralCredits'];
}): Promise<number> => {
  if (input.deferralCredits.length === 0) return 0;
  const events = await bankLedgerEvents();
  const candidates = events.filter((event) => {
    if (event.institution !== 'american_express_mx') return false;
    if (event.status === 'rejected' || event.status === 'deferred_msi') return false;
    if (event.msi) return false;
    const account = event.account as JsonObject | undefined;
    if (String(account?.lastFour ?? '') !== input.accountLastFour) return false;
    const amount = event.amount as { amountMinor?: number } | undefined;
    return Number.isSafeInteger(amount?.amountMinor) && (amount?.amountMinor ?? 0) > 0;
  });

  let deferred = 0;
  const usedIds = new Set<string>();
  for (const credit of input.deferralCredits) {
    const available = candidates
      .filter((event) => !usedIds.has(String(event.id)))
      .map((event) => ({
        id: String(event.id),
        amountMinor: Number((event.amount as { amountMinor?: number }).amountMinor),
      }));
    const matchedIds = findDeferralPurchaseSubset(available, credit.amountMinor);
    if (!matchedIds) continue;
    for (const eventId of matchedIds) {
      if (await markDeferredMsi(eventId, input.owner, credit.identity)) {
        usedIds.add(eventId);
        deferred += 1;
      }
    }
  }
  return deferred;
};

import { resolveStatementSource } from './statement-upload.js';
import { readBankImport, startBankImport, saveStatementPreview, failBankImport, type BankImportRecord } from './import-sql.js';
import {
  InvalidSantanderStatementError,
  parseSantanderStatementExtraction,
  type SantanderStatementDocument,
} from './santander-statement.js';
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

const buildSantanderStatementPreviewRows = async (
  document: SantanderStatementDocument,
): Promise<readonly StatementPreviewRow[]> => {
  const events = await bankLedgerEvents();
  const identities = document.charges.map((charge) => charge.identity);
  const claimed = await claimedStatementIdentities('santander', identities);
  const purchaseRows = document.charges
    .filter((charge) => !charge.msi)
    .map((charge) => classifyPurchaseCharge({
      provider: 'santander',
      accountLastFour: document.accountLastFour,
      institution: 'santander_mx',
      charge,
      events,
      claimed,
      localDate,
    }));
  const msiRows = document.msiCharges.map((charge) => classifyMsiEvidenceRow({
    merchantRaw: charge.merchantRaw,
    amountMinor: charge.amountMinor,
    occurredOn: charge.occurredOn,
    identity: charge.identity,
    installmentIndex: charge.installmentIndex,
    installmentMonths: charge.installmentMonths,
    originalAmountMinor: charge.originalAmountMinor,
  }, events));
  return [...purchaseRows, ...msiRows];
};

export const previewSantanderStatementImport = async (
  event: StatementImportEvent,
  owner: string,
): Promise<JsonObject> => {
  const source = await resolveStatementSource('santander', owner, event);
  const sha256 = source.sha256;
  const existing = await readBankImport('santander_statement', sha256, owner);
  if (existing?.status === 'applied' || existing?.status === 'processing') return statementImportResponse(existing);
  const textractJobId = await startTextractDocumentAnalysis(
    textract,
    rawSourceBucketName,
    source.key,
    'santander',
    existing?.textractJobId,
  );
  const saved = await startBankImport({
    kind: 'santander_statement', importId: sha256, owner, status: 'processing',
    createdAt: new Date().toISOString(), source, textractJobId, rows: [],
  });
  return statementImportResponse(saved, 'Leyendo el PDF con Textract. Consulta el estado en unos segundos.');
};

export const getSantanderStatementImport = async (importId: string, owner: string): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) throw new InvalidSantanderStatementError('Identificador de importación inválido.');
  const stored = await readBankImport('santander_statement', importId, owner);
  if (!stored) throw new InvalidSantanderStatementError('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  if (stored.status !== 'processing') return statementImportResponse(stored);
  const jobId = stored.textractJobId;
  if (!jobId) throw new Error('Missing native statement Textract job.');
  let job;
  try { job = await getTextractAnalysisJobStatus(textract, jobId); }
  catch (error) {
    if (!(error instanceof TextractDocumentError)) throw error;
    const current = await failBankImport('santander_statement', importId, owner, jobId, error.message);
    if (current.status !== 'failed' || current.textractJobId !== jobId) return statementImportResponse(current);
    throw error;
  }
  if (job.status === 'IN_PROGRESS') return statementImportResponse(stored);
  if (job.status === 'FAILED') {
    const message = job.statusMessage ?? 'Textract falló al leer el PDF.';
    const current = await failBankImport('santander_statement', importId, owner, jobId, message);
    if (current.status !== 'failed' || current.textractJobId !== jobId) return statementImportResponse(current);
    throw new TextractDocumentError(message);
  }

  let extractionKey: string | undefined;
  let answers: Readonly<Record<string, string>> = {};
  let preview: Pick<BankImportRecord, 'accountLastFour' | 'product' | 'period' | 'rows' | 'extractionKey' | 'textractAnswers'>;
  try {
    const extraction = await fetchTextractStatementExtraction(textract, jobId, 'santander');
    extractionKey = await persistTextractExtraction(stored.source.key, extraction);
    const retained = await loadStatementTextractExtraction({source: stored.source, extractionKey});
    answers = retained.answers;
    const document = parseSantanderStatementExtraction(retained);
    const rows = await buildSantanderStatementPreviewRows(document);
    preview = { accountLastFour: document.accountLastFour, product: document.product,
      period: document.period, rows, extractionKey, textractAnswers: answers };
  } catch (error) {
    // Transient storage/query failures leave processing retryable; only document failures end the job.
    if (!(error instanceof InvalidSantanderStatementError) && !(error instanceof TextractDocumentError)) throw error;
    const current = await failBankImport('santander_statement', importId, owner, jobId, error.message,
      extractionKey ? { extractionKey, textractAnswers: answers } : {});
    if (current.status !== 'failed' || current.textractJobId !== jobId) return statementImportResponse(current);
    throw error;
  }
  const current = await saveStatementPreview('santander_statement', importId, owner, jobId, preview);
  return statementImportResponse(current);
};

export const applySantanderStatementImport = async (
  importId: string,
  owner: string,
  decisionBody: string | undefined,
): Promise<JsonObject> => applyStatementImport({
  provider: 'santander',
  importId,
  owner,
  decisionBody,
  prepareRows: async (stored) => {
    const document = parseSantanderStatementExtraction(await loadStatementTextractExtraction(stored));
    return { rebuildRows: () => buildSantanderStatementPreviewRows(document) };
  },
});

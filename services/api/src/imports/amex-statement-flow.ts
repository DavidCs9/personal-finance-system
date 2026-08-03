import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  headerValue,
  loadStatementTextractExtraction,
  persistTextractExtraction,
  requestBinaryBody,
  statementPreviewResponse,
  type StatementImportEvent,
} from './statement-shared.js';
import { database, rawSourceBucketName, s3, tableName, textract } from '../http/clients.js';
import { errorMessage, type JsonObject } from '../http/response.js';
import { allStoredEvents, localDate } from '../events/queries.js';
import { markDeferredMsi } from '../events/mutations.js';

const amexSourceKey = (owner: string, sha256: string): string =>
  `manual-imports/amex/${owner}/${sha256}.pdf`;

const buildAmexPreviewRows = async (
  document: AmexStatementDocument,
): Promise<readonly StatementPreviewRow[]> => {
  const events = await allStoredEvents();
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
  const contentType = (headerValue(event, 'content-type') ?? 'application/pdf').toLowerCase();
  const bytes = requestBinaryBody(event);
  if (!bytes || bytes.length === 0) throw new InvalidAmexStatementError('El estado de cuenta Amex está vacío.');
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new InvalidAmexStatementError('Sube el PDF del estado de cuenta Amex.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = {
    bucket: rawSourceBucketName,
    key: amexSourceKey(owner, sha256),
    sha256,
    contentType: 'application/pdf' as const,
  };
  await s3.send(new PutObjectCommand({
    Bucket: rawSourceBucketName,
    Key: source.key,
    Body: bytes,
    ContentType: 'application/pdf',
  }));
  const textractJobId = await startTextractDocumentAnalysis(
    textract,
    rawSourceBucketName,
    source.key,
    'amex',
  );
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${owner}`,
      SK: `IMPORT#AMEX#${sha256}`,
      entityType: 'amex_statement_import',
      owner,
      status: 'processing',
      createdAt: new Date().toISOString(),
      source,
      textractJobId,
    },
  }));
  return {
    importId: sha256,
    status: 'processing',
    message: 'Leyendo el PDF con Textract. Consulta el estado en unos segundos.',
  };
};

export const getAmexImport = async (importId: string, owner: string): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) {
    throw new InvalidAmexStatementError('Identificador de importación inválido.');
  }
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
    ConsistentRead: true,
  }));
  if (!stored.Item || stored.Item.owner !== owner) {
    throw new InvalidAmexStatementError('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.Item.status === 'previewed' || stored.Item.status === 'applied') {
    const rows = Array.isArray(stored.Item.rows) ? stored.Item.rows as readonly StatementPreviewRow[] : [];
    return statementPreviewResponse(
      importId,
      {
        accountLastFour: String(stored.Item.accountLastFour ?? ''),
        product: String(stored.Item.product ?? 'American Express'),
        period: stored.Item.period as { readonly from: string; readonly to: string },
      },
      rows,
    );
  }
  if (stored.Item.status === 'failed') {
    throw new InvalidAmexStatementError(
      typeof stored.Item.errorMessage === 'string'
        ? stored.Item.errorMessage
        : 'No se pudo leer el estado Amex.',
    );
  }

  const jobId = typeof stored.Item.textractJobId === 'string' ? stored.Item.textractJobId : undefined;
  if (!jobId) throw new InvalidAmexStatementError('Falta el trabajo de Textract para este import.');

  const job = await getTextractAnalysisJobStatus(textract, jobId);
  if (job.status === 'IN_PROGRESS') {
    return {
      importId,
      status: 'processing',
      message: 'Textract sigue leyendo el PDF…',
    };
  }
  if (job.status === 'FAILED') {
    const message = job.statusMessage ?? 'Textract falló al leer el PDF.';
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      UpdateExpression: 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: { '#status': 'status', '#errorMessage': 'errorMessage' },
      ExpressionAttributeValues: { ':status': 'failed', ':errorMessage': message },
    }));
    throw new TextractDocumentError(message);
  }

  const source = stored.Item.source as JsonObject;
  const sourceKey = typeof source.key === 'string'
    ? source.key
    : amexSourceKey(owner, importId);
  let extractionKey: string | undefined;
  let answers: Readonly<Record<string, string>> = {};
  try {
    const extraction = await fetchTextractStatementExtraction(textract, jobId, 'amex');
    answers = extraction.answers;
    console.info('Amex Textract extraction ready', {
      importId,
      jobId,
      answers: Object.keys(extraction.answers),
      tables: extraction.tables.length,
      lines: extraction.lines.length,
    });
    extractionKey = await persistTextractExtraction(sourceKey, extraction);
    const document = parseAmexStatementExtraction(extraction);
    const rows = await buildAmexPreviewRows(document);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      UpdateExpression: 'SET #status = :status, #accountLastFour = :accountLastFour, #product = :product, #period = :period, #rows = :rows, #extractionKey = :extractionKey, #textractAnswers = :textractAnswers',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#accountLastFour': 'accountLastFour',
        '#product': 'product',
        '#period': 'period',
        '#rows': 'rows',
        '#extractionKey': 'extractionKey',
        '#textractAnswers': 'textractAnswers',
      },
      ExpressionAttributeValues: {
        ':status': 'previewed',
        ':accountLastFour': document.accountLastFour,
        ':product': document.product,
        ':period': document.period,
        ':rows': rows,
        ':extractionKey': extractionKey,
        ':textractAnswers': extraction.answers,
      },
    }));
    return statementPreviewResponse(importId, document, rows);
  } catch (error) {
    const message = errorMessage(error);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
      UpdateExpression: extractionKey
        ? 'SET #status = :status, #errorMessage = :errorMessage, #extractionKey = :extractionKey, #textractAnswers = :textractAnswers'
        : 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#errorMessage': 'errorMessage',
        ...(extractionKey
          ? { '#extractionKey': 'extractionKey', '#textractAnswers': 'textractAnswers' }
          : {}),
      },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':errorMessage': message,
        ...(extractionKey
          ? {
              ':extractionKey': extractionKey,
              ':textractAnswers': answers,
            }
          : {}),
      },
    }));
    if (error instanceof InvalidAmexStatementError || error instanceof TextractDocumentError) {
      throw error;
    }
    throw new InvalidAmexStatementError(message);
  }
};

export const applyAmexImport = async (
  importId: string,
  owner: string,
  decisionBody: string | undefined,
): Promise<JsonObject> => {
  const result = await applyStatementImport({
    provider: 'amex',
    importId,
    owner,
    decisionBody,
    rebuildRows: async () => {
      const stored = await database.send(new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
        ConsistentRead: true,
      }));
      const extraction = await loadStatementTextractExtraction(stored.Item as JsonObject);
      return buildAmexPreviewRows(parseAmexStatementExtraction(extraction));
    },
  });

  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#AMEX#${importId}` },
    ConsistentRead: true,
  }));
  const accountLastFour = String(stored.Item?.accountLastFour ?? '');
  try {
    const extraction = await loadStatementTextractExtraction(stored.Item as JsonObject);
    const document = parseAmexStatementExtraction(extraction);
    const deferred = await applyAmexDeferralCredits({
      owner,
      accountLastFour: document.accountLastFour || accountLastFour,
      deferralCredits: document.deferralCredits,
    });
    const summary = {
      ...(result.summary as JsonObject),
      deferredMsi: deferred,
    };
    return { ...result, summary };
  } catch {
    return result;
  }
};

const applyAmexDeferralCredits = async (input: {
  readonly owner: string;
  readonly accountLastFour: string;
  readonly deferralCredits: AmexStatementDocument['deferralCredits'];
}): Promise<number> => {
  if (input.deferralCredits.length === 0) return 0;
  const events = await allStoredEvents();
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

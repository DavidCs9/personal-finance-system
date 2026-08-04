import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

const santanderStatementSourceKey = (owner: string, sha256: string): string =>
  `manual-imports/santander-statement/${owner}/${sha256}.pdf`;

const buildSantanderStatementPreviewRows = async (
  document: SantanderStatementDocument,
): Promise<readonly StatementPreviewRow[]> => {
  const events = await allStoredEvents();
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
  const contentType = (headerValue(event, 'content-type') ?? 'application/pdf').toLowerCase();
  const bytes = requestBinaryBody(event);
  if (!bytes || bytes.length === 0) {
    throw new InvalidSantanderStatementError('El estado de cuenta Santander está vacío.');
  }
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new InvalidSantanderStatementError('Sube el PDF del estado de cuenta Santander.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = {
    bucket: rawSourceBucketName,
    key: santanderStatementSourceKey(owner, sha256),
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
    'santander',
  );
  await database.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `USER#${owner}`,
      SK: `IMPORT#SANTANDER_STATEMENT#${sha256}`,
      entityType: 'santander_statement_import',
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

export const getSantanderStatementImport = async (importId: string, owner: string): Promise<JsonObject> => {
  if (!/^[a-f0-9]{64}$/.test(importId)) {
    throw new InvalidSantanderStatementError('Identificador de importación inválido.');
  }
  const stored = await database.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
    ConsistentRead: true,
  }));
  if (!stored.Item || stored.Item.owner !== owner) {
    throw new InvalidSantanderStatementError('La previsualización ya no está disponible. Vuelve a seleccionar el estado de cuenta.');
  }
  if (stored.Item.status === 'previewed' || stored.Item.status === 'applied') {
    const rows = Array.isArray(stored.Item.rows) ? stored.Item.rows as readonly StatementPreviewRow[] : [];
    return statementPreviewResponse(
      importId,
      {
        accountLastFour: String(stored.Item.accountLastFour ?? ''),
        product: String(stored.Item.product ?? 'Santander'),
        period: stored.Item.period as { readonly from: string; readonly to: string },
      },
      rows,
    );
  }
  if (stored.Item.status === 'failed') {
    throw new InvalidSantanderStatementError(
      typeof stored.Item.errorMessage === 'string'
        ? stored.Item.errorMessage
        : 'No se pudo leer el estado Santander.',
    );
  }

  const jobId = typeof stored.Item.textractJobId === 'string' ? stored.Item.textractJobId : undefined;
  if (!jobId) throw new InvalidSantanderStatementError('Falta el trabajo de Textract para este import.');

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
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
      UpdateExpression: 'SET #status = :status, #errorMessage = :errorMessage',
      ExpressionAttributeNames: { '#status': 'status', '#errorMessage': 'errorMessage' },
      ExpressionAttributeValues: { ':status': 'failed', ':errorMessage': message },
    }));
    throw new TextractDocumentError(message);
  }

  const source = stored.Item.source as JsonObject;
  const sourceKey = typeof source.key === 'string'
    ? source.key
    : santanderStatementSourceKey(owner, importId);
  let extractionKey: string | undefined;
  let answers: Readonly<Record<string, string>> = {};
  try {
    const extraction = await fetchTextractStatementExtraction(textract, jobId, 'santander');
    answers = extraction.answers;
    console.info('Santander Textract extraction ready', {
      importId,
      jobId,
      answers: Object.keys(extraction.answers),
      tables: extraction.tables.length,
      lines: extraction.lines.length,
    });
    extractionKey = await persistTextractExtraction(sourceKey, extraction);
    const document = parseSantanderStatementExtraction(extraction);
    const rows = await buildSantanderStatementPreviewRows(document);
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
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
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
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
    if (
      error instanceof InvalidSantanderStatementError
      || error instanceof TextractDocumentError
    ) {
      throw error;
    }
    throw new InvalidSantanderStatementError(message);
  }
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
  rebuildRows: async () => {
    const stored = await database.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `USER#${owner}`, SK: `IMPORT#SANTANDER_STATEMENT#${importId}` },
      ConsistentRead: true,
    }));
    const extraction = await loadStatementTextractExtraction(stored.Item as JsonObject);
    return buildSantanderStatementPreviewRows(parseSantanderStatementExtraction(extraction));
  },
});

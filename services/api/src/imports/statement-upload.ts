import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_STATEMENT_PDF_BYTES, type StatementUploadInput, type StatementUploadTarget } from '@finance/domain';
import { rawSourceBucketName, s3 } from '../http/clients.js';
import { errorName } from '../http/response.js';
import { InvalidAmexStatementError } from './amex-statement.js';
import { InvalidSantanderStatementError } from './santander-statement.js';
import { headerValue, requestBinaryBody, type StatementImportEvent } from './statement-shared.js';
import type { StatementProvider } from './statement-reconciliation.js';

const invalid = (provider: StatementProvider, message: string): Error =>
  provider === 'amex' ? new InvalidAmexStatementError(message) : new InvalidSantanderStatementError(message);

const parseUpload = (body: string | undefined, provider: StatementProvider): StatementUploadInput => {
  let input: unknown;
  try { input = JSON.parse(body ?? '{}'); }
  catch { throw invalid(provider, 'Los datos del PDF no son válidos. Vuelve a seleccionarlo.'); }
  if (!input || typeof input !== 'object' || !('sha256' in input) || !('size' in input)
    || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)
    || typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size <= 0) {
    throw invalid(provider, 'Los datos del PDF no son válidos. Vuelve a seleccionarlo.');
  }
  if (input.size > MAX_STATEMENT_PDF_BYTES) throw invalid(provider, 'El PDF supera el máximo de 50 MB.');
  return { sha256: input.sha256, size: input.size };
};

const sourceOf = (provider: StatementProvider, owner: string, sha256: string) => ({
  bucket: rawSourceBucketName,
  key: `manual-imports/${provider === 'amex' ? 'amex' : 'santander-statement'}/${owner}/${sha256}.pdf`,
  sha256,
  contentType: 'application/pdf' as const,
});

export const createStatementUpload = async (
  provider: StatementProvider, owner: string, body: string | undefined,
): Promise<StatementUploadTarget> => {
  const input = parseUpload(body, provider);
  const source = sourceOf(provider, owner, input.sha256);
  const checksum = Buffer.from(input.sha256, 'hex').toString('base64');
  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: source.bucket, Key: source.key, ContentType: source.contentType,
    ContentLength: input.size, ChecksumSHA256: checksum, IfNoneMatch: '*',
  }), {
    expiresIn: 600,
    signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']),
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  });
  return { url, headers: { 'Content-Type': source.contentType, 'x-amz-checksum-sha256': checksum, 'If-None-Match': '*' } };
};

/** Resolve only the authenticated owner's content-addressed original, never a client-supplied key. */
export const resolveStatementSource = async (
  provider: StatementProvider, owner: string, event: StatementImportEvent,
) => {
  const contentType = (headerValue(event, 'content-type') ?? 'application/pdf').toLowerCase();
  if (contentType.split(';')[0].trim() !== 'application/json') {
    throw invalid(provider, 'Sube el PDF directamente con el enlace de carga.');
  }
  const body = requestBinaryBody(event)?.toString('utf8');
  const input = parseUpload(body, provider);
  const source = sourceOf(provider, owner, input.sha256);
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: source.bucket, Key: source.key, ChecksumMode: 'ENABLED' }));
  } catch (error) {
    if (errorName(error) === 'NotFound' || errorName(error) === 'NoSuchKey') {
      throw invalid(provider, 'El PDF no terminó de subir. Vuelve a seleccionarlo.');
    }
    throw error;
  }
  if (head.ContentLength !== input.size || head.ContentType !== source.contentType
    || (head.ChecksumSHA256 && head.ChecksumSHA256 !== Buffer.from(input.sha256, 'hex').toString('base64'))) {
    throw invalid(provider, 'El PDF guardado no coincide con el archivo seleccionado. Vuelve a subirlo.');
  }
  // Older originals predate S3 checksums. Verify their full hash without replacing their evidence.
  const original = await s3.send(new GetObjectCommand({
    Bucket: source.bucket, Key: source.key, ...(head.ChecksumSHA256 ? { Range: 'bytes=0-4' } : {}),
  }));
  const bytes = await original.Body?.transformToByteArray();
  if (!bytes || Buffer.from(bytes).subarray(0, 5).toString('ascii') !== '%PDF-'
    || (!head.ChecksumSHA256 && createHash('sha256').update(bytes).digest('hex') !== input.sha256)) {
    throw invalid(provider, 'Sube un PDF válido del estado de cuenta.');
  }
  return source;
};

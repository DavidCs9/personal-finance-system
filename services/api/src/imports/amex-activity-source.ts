import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { rawSourceBucketName, s3 } from '../http/clients.js';
import { errorName } from '../http/response.js';
import { AMEX_ACTIVITY_CONTENT_TYPE, InvalidAmexActivityError, MAX_AMEX_ACTIVITY_BYTES } from './amex-activity.js';
import { readBankImport } from './import-sql.js';

export const parseActivityUpload = (body: string | undefined): { sha256: string; size: number } => {
  let value: { sha256?: unknown; size?: unknown };
  try { value = JSON.parse(body ?? '{}'); } catch { throw new InvalidAmexActivityError('Los datos del Excel no son válidos.'); }
  if (!value || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_AMEX_ACTIVITY_BYTES)
    throw new InvalidAmexActivityError('Selecciona un Excel Amex de hasta 2 MB.');
  return { sha256: value.sha256, size: value.size };
};
export const activitySource = (owner: string, sha256: string) => ({ bucket: rawSourceBucketName,
  key: `manual-imports/amex-activity/${owner}/${sha256}.xlsx`, sha256, contentType: AMEX_ACTIVITY_CONTENT_TYPE });

export const getAmexActivitySource = async (importId: string, owner: string) => {
  if (!/^[a-f0-9]{64}$/.test(importId) || !await readBankImport('amex_activity', importId, owner))
    throw new InvalidAmexActivityError('Excel Amex no encontrado.');
  const source = activitySource(owner, importId);
  return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: source.bucket, Key: source.key,
    ResponseContentDisposition: 'attachment; filename="actividad-amex.xlsx"' }), { expiresIn: 600 }) };
};

export const createAmexActivityUpload = async (body: string | undefined, owner: string) => {
  const input = parseActivityUpload(body), source = activitySource(owner, input.sha256);
  const checksum = Buffer.from(input.sha256, 'hex').toString('base64');
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: source.bucket, Key: source.key,
    ContentType: source.contentType, ContentLength: input.size, ChecksumSHA256: checksum, IfNoneMatch: '*' }), {
    expiresIn: 600, signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']),
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  });
  return { url, headers: { 'Content-Type': source.contentType, 'x-amz-checksum-sha256': checksum, 'If-None-Match': '*' } };
};
export const loadAmexActivitySource = async (owner: string, sha256: string, expectedSize?: number): Promise<Uint8Array> => {
  const source = activitySource(owner, sha256);
  let object;
  try { object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key })); }
  catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(errorName(error) ?? ''))
      throw new InvalidAmexActivityError('El Excel no terminó de subir. Vuelve a seleccionarlo.');
    throw error;
  }
  if (!object.Body) throw new InvalidAmexActivityError('El Excel guardado está vacío.');
  if (object.ContentLength !== undefined && (object.ContentLength > MAX_AMEX_ACTIVITY_BYTES
    || expectedSize !== undefined && object.ContentLength !== expectedSize)) {
    if ('destroy' in object.Body) object.Body.destroy();
    else await object.Body.transformToWebStream().cancel();
    throw new InvalidAmexActivityError('El Excel guardado no coincide con el seleccionado.');
  }
  const bytes = await object.Body.transformToByteArray();
  if (bytes.length > MAX_AMEX_ACTIVITY_BYTES || expectedSize !== undefined && bytes.length !== expectedSize
    || object.ContentType !== AMEX_ACTIVITY_CONTENT_TYPE || createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new InvalidAmexActivityError('El Excel guardado no coincide con el seleccionado.');
  return bytes;
};

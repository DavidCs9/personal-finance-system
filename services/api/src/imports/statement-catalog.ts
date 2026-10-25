import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildStatementCatalog, type StatementCatalog, type StatementDocument } from '@finance/domain';
import { readerPool, type ReadSqlClient } from '../events/sql-reads.js';
import { s3 } from '../http/clients.js';
import { BankImportError } from './import-sql.js';

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

/** Native import headers only: no financial joins, extraction polling or writes. */
export const getStatementCatalog = async (owner: string, now = new Date(), client: ReadSqlClient = readerPool()): Promise<StatementCatalog> => {
  const { rows } = await client.query(`SELECT kind,content_sha256,status,created_at,applied_at,account_last_four,product,
    period_start::text AS period_start,period_end::text AS period_end FROM olbia.bank_imports
    WHERE owner=$1 AND kind IN ('amex_statement','santander_statement') ORDER BY created_at,content_sha256`, [owner]);
  return buildStatementCatalog(rows.map((row): StatementDocument => ({
    provider: row.kind === 'amex_statement' ? 'amex' : 'santander', importId: String(row.content_sha256),
    status: row.status as StatementDocument['status'], createdAt: iso(row.created_at),
    ...(row.applied_at != null ? { appliedAt: iso(row.applied_at) } : {}),
    ...(row.account_last_four != null ? { accountLastFour: String(row.account_last_four) } : {}),
    ...(row.product != null ? { product: String(row.product) } : {}),
    ...(row.period_start != null ? { period: { from: String(row.period_start), to: String(row.period_end) } } : {}),
  })), now);
};

/** A short-lived native S3 GET bound to the authenticated owner's registered original. */
export const getStatementSource = async (provider: string, importId: string, owner: string, client: ReadSqlClient = readerPool()) => {
  if ((provider !== 'amex' && provider !== 'santander') || !/^[a-f0-9]{64}$/.test(importId)) {
    throw new BankImportError('El estado de cuenta no es válido.');
  }
  const { rows } = await client.query(`SELECT evidence_bucket,evidence_key FROM olbia.bank_imports
    WHERE kind=$1 AND content_sha256=$2 AND owner=$3`, [provider === 'amex' ? 'amex_statement' : 'santander_statement', importId, owner]);
  const source = rows[0];
  if (!source) return undefined;
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: String(source.evidence_bucket), Key: String(source.evidence_key),
    ResponseContentType: 'application/pdf', ResponseContentDisposition: 'inline' }), { expiresIn: 600 });
  return { url };
};

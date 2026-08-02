/**
 * Probe real SES emails in S3 with the Textract-only email extractor.
 *
 * Usage:
 *   RAW_EMAIL_BUCKET_NAME=personalfinancev1-rawemailbucket... \
 *   AWS_REGION=us-east-2 \
 *   npx tsx scripts/probe-email-textract.ts [--limit 8]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { TextractClient } from '@aws-sdk/client-textract';
import {
  detectEmailInstitution,
  documentTextForTextract,
  header,
  shouldIgnoreEmail,
} from '@finance/ingestion';
import {
  analyzeEmailWithTextract,
  renderEmailBodyPdf,
} from '../lambda/email-textract.js';
import { mapTextractEmailPurchase } from '@finance/ingestion';

const bucket = process.env.RAW_EMAIL_BUCKET_NAME
  ?? process.env.RAW_EMAIL_BUCKET
  ?? 'personalfinancev1-rawemailbucket251d8c5c-bf3phs9p4sgg';
const prefix = process.env.RAW_EMAIL_PREFIX ?? 'inbound/';
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-2';
const limitFlagIndex = process.argv.indexOf('--limit');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length)
  ?? (limitFlagIndex >= 0 ? process.argv[limitFlagIndex + 1] : undefined);
const parsedLimit = Number(limitArg);
const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 12;

const s3 = new S3Client({ region });
const textract = new TextractClient({ region });

const listInboundKeys = async (): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key || item.Key.endsWith('/')) continue;
      if (item.Key.endsWith('.textract.json')) continue;
      keys.push(item.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys.sort().reverse();
};

const main = async (): Promise<void> => {
  const outDir = path.resolve('/tmp/real-email-textract-probe');
  await mkdir(outDir, { recursive: true });
  console.log(JSON.stringify({ message: 'Listing inbound emails', bucket, prefix, region, limit }));
  const keys = await listInboundKeys();
  console.log(JSON.stringify({ message: 'Found inbound objects', count: keys.length }));
  if (keys.length === 0) {
    throw new Error(`No objects under s3://${bucket}/${prefix}`);
  }

  const selected = keys.slice(0, limit);
  const results: Array<Record<string, unknown>> = [];

  for (const key of selected) {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const mime = await object.Body?.transformToString('utf-8');
    if (!mime) {
      results.push({ key, ok: false, error: 'empty body' });
      continue;
    }
    const safeName = key.replace(/[^\w.-]+/g, '_');
    await writeFile(path.join(outDir, `${safeName}.eml`), mime, 'utf8');

    if (shouldIgnoreEmail(mime)) {
      results.push({ key, ok: true, skipped: 'ignored_admin_email' });
      continue;
    }

    const institution = detectEmailInstitution(mime);
    const from = header(mime, 'from');
    const subject = header(mime, 'subject');
    if (!institution) {
      results.push({
        key, ok: false, from, subject, error: 'unsupported_source',
        documentPreview: documentTextForTextract(mime).slice(0, 240),
      });
      continue;
    }

    try {
      const pdf = renderEmailBodyPdf(documentTextForTextract(mime));
      const extraction = await analyzeEmailWithTextract(textract, institution, pdf);
      const purchase = mapTextractEmailPurchase(institution, extraction);
      await writeFile(
        path.join(outDir, `${safeName}.textract.json`),
        JSON.stringify({ institution, extraction, purchase }, null, 2),
        'utf8',
      );
      results.push({
        key,
        ok: true,
        from,
        subject,
        institution,
        parserVersion: purchase.parserVersion,
        merchantRaw: purchase.merchantRaw,
        amountMinor: purchase.amount.amountMinor,
        accountLastFour: purchase.account?.lastFour,
        occurredAt: purchase.occurredAt,
        billingPeriod: purchase.billingPeriod,
        answers: extraction.answers,
      });
      console.log(JSON.stringify({
        message: 'Mapped email',
        key,
        institution,
        merchantRaw: purchase.merchantRaw,
        amountMinor: purchase.amount.amountMinor,
      }));
    } catch (error) {
      results.push({
        key,
        ok: false,
        from,
        subject,
        institution,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(JSON.stringify({
        message: 'Failed email',
        key,
        institution,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const summaryPath = path.join(outDir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify({ bucket, prefix, results }, null, 2), 'utf8');
  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  console.log(JSON.stringify({
    message: 'Probe finished',
    summaryPath,
    passed,
    failed,
    total: results.length,
  }));
  if (failed > 0) process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

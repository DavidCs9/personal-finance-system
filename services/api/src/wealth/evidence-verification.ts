import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { WealthSnapshot, CardLiabilitySnapshot } from '@finance/domain';
import { s3 } from '../http/clients.js';
import { samePublicResult } from '../events/read-selection.js';
import { verifyLedgerEvidence } from '../events/evidence-verification.js';
import type { JsonObject } from '../http/response.js';

export interface WealthEvidenceAssertion { readonly owner: string; readonly snapshot: WealthSnapshot | CardLiabilitySnapshot }
const originalBytes = async (bucket: string, key: string): Promise<Uint8Array> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error('Missing original wealth evidence body');
  return object.Body.transformToByteArray();
};
const originalFactsMatch = (assertion: WealthEvidenceAssertion, original: JsonObject): boolean => {
  const s = assertion.snapshot;
  const header = { owner: assertion.owner, day: s.day };
  if ('accountId' in s) {
    const kinds = { manual: 'wealth_manual_snapshot', api: 'wealth_bitso_snapshot', flex: 'wealth_ibkr_snapshot', derived: undefined };
    if (!kinds[s.source]) return false;
    return samePublicResult({ ...header, kind: kinds[s.source], accountId: s.accountId, holdings: s.holdings,
      ...(s.source === 'manual' ? { amountMinor: s.totalMxnMinor } : {}),
      ...(s.fxRate === undefined ? {} : { fxRate: s.fxRate }), ...(s.fxSource === undefined ? {} : { fxSource: s.fxSource }) },
    { owner: original.owner, day: original.day, kind: original.kind, accountId: original.accountId, holdings: original.holdings,
      ...(s.source === 'manual' ? { amountMinor: original.amountMinor } : {}),
      ...(original.fxRate === undefined ? {} : { fxRate: original.fxRate }), ...(original.fxSource === undefined ? {} : { fxSource: original.fxSource }) });
  }
  return samePublicResult({ ...header, kind: 'wealth_liability_manual_snapshot', cardId: s.cardId, amountMinor: s.totalMxnMinor },
    { owner: original.owner, day: original.day, kind: original.kind, cardId: original.cardId, amountMinor: original.amountMinor });
};

/** Reuse unique-object hash verification and consume each body once, after the SQL snapshot closes. */
export const verifyWealthEvidence = async (assertions: readonly WealthEvidenceAssertion[], readBytes = originalBytes) => {
  let factMismatches = 0, financialAssertions = 0;
  const byObject = new Map<string, WealthEvidenceAssertion[]>();
  const generic = assertions.map(assertion => {
    const e = assertion.snapshot.evidence;
    if (e) {
      const key = JSON.stringify([e.bucket, e.key]);
      byObject.set(key, [...byObject.get(key) ?? [], assertion]);
    }
    return { evidence_bucket: e?.bucket, evidence_key: e?.key, evidence_sha256: e?.sha256, evidence_content_type: e?.contentType };
  });
  const hashes = await verifyLedgerEvidence(generic, async (bucket, key) => {
    const bytes = await readBytes(bucket, key);
    let body: JsonObject | undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as JsonObject;
    } catch { /* Malformed originals fail comparison without exposing their content. */ }
    for (const assertion of byObject.get(JSON.stringify([bucket, key])) ?? []) {
      financialAssertions++; factMismatches += Number(!body || !originalFactsMatch(assertion, body));
    }
    return bytes;
  });
  return { ...hashes, financialAssertions, factMismatches, mismatches: hashes.mismatches + factMismatches };
};

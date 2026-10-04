import { samePublicResult } from '../../src/events/read-selection.js';
import type { ReadSqlClient } from '../../src/events/sql-reads.js';
import type { JsonObject } from '../../src/http/response.js';
import type { readIndependentWealthState } from '../../src/wealth/native-verification.js';
/** Frozen former daily selections prove originals; legitimate later native captures do not overwrite them. */
export const verifyWealthRecovery = async (owner: string, client: ReadSqlClient, state: Awaited<ReturnType<typeof readIndependentWealthState>>) => {
  let mismatches = 0, assertions = 0;
  for (const table of ['wealth_snapshots', 'wealth_versions', 'liability_snapshots', 'liability_versions']) {
    const rows = (await client.query(`SELECT source_item FROM olbia.${table} WHERE owner=$1`, [owner])).rows;
    const asset = table.startsWith('wealth_'), version = table.endsWith('_versions');
    for (const row of rows) {
      assertions++; const original = row.source_item as JsonObject;
      const expected = { ...(asset ? { accountId: original.accountId, holdings: original.holdings,
        ...(original.fxRate === undefined ? {} : { fxRate: original.fxRate }), ...(original.fxSource === undefined ? {} : { fxSource: original.fxSource }) }
        : { cardId: original.cardId }),
      day: original.day, capturedAt: original.capturedAt, source: original.source, currency: 'MXN', totalMxnMinor: original.totalMxnMinor, evidence: original.evidence };
      const facts = asset ? state.assetFacts : state.liabilityFacts;
      if (version) {
        const prior = facts.get(String(original.versionId)), edge = state.audit.find(r => r.captureId === original.versionId && r.kind === (asset ? 'asset' : 'liability'));
        mismatches += Number(!samePublicResult(expected, prior));
        mismatches += Number(!edge || edge.replacedAt !== original.supersededAt);
      } else mismatches += Number(![...facts.values()].some(fact => samePublicResult(expected, fact)));
    }
  }
  return { assertions, mismatches };
};

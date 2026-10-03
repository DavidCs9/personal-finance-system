import { FONDO_AHORRO_ACCOUNT_ID, WEALTH_ACCOUNTS,
  type WealthAccountDefinition, type WealthHolding, type WealthSnapshot, type CardLiabilitySnapshot } from '@finance/domain';
import { samePublicResult } from '../events/read-selection.js';
import type { ReadSqlClient } from '../events/sql-reads.js';
import type { JsonObject } from '../http/response.js';
import type { NativeWealthAudit, NativeWealthInputs } from './native-reads.js';

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const day = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const money = (value: unknown): number => {
  const exact = BigInt(String(value));
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Unsafe native wealth assertion');
  return Number(exact);
};
const requiredRelations = [
  'asset_accounts_pkey', 'asset_captures_pkey', 'asset_holdings_pkey', 'asset_daily_captures_pkey', 'asset_capture_replacements_pkey',
  'liability_captures_pkey', 'liability_daily_captures_pkey', 'liability_capture_replacements_pkey',
  'asset_captures_account_id_fkey', 'asset_holdings_capture_id_fkey', 'liability_captures_card_id_fkey',
  'asset_daily_capture_ownership_fk', 'liability_daily_capture_ownership_fk',
  'asset_replacement_previous_ownership_fk', 'asset_replacement_next_ownership_fk',
  'liability_replacement_previous_ownership_fk', 'liability_replacement_next_ownership_fk',
  'asset_holdings_identity_key', 'asset_captures_daily_identity_key', 'liability_captures_daily_identity_key',
  'asset_daily_captures_capture_id_key', 'liability_daily_captures_capture_id_key',
  'asset_capture_replacements_replacement_capture_id_key', 'liability_capture_replacements_replacement_capture_id_key',
] as const;

/** Independent typed-row oracle. No product decoder, projection or document reader selects these balances. */
export const readIndependentWealthState = async (owner: string, client: ReadSqlClient) => {
  const [accounts, assets, holdings, assetDays, assetEdges, liabilities, liabilityDays, liabilityEdges, cards, constraints] = await Promise.all([
    client.query('SELECT * FROM olbia.asset_accounts ORDER BY position'),
    client.query('SELECT * FROM olbia.asset_captures WHERE owner=$1 ORDER BY id', [owner]),
    client.query('SELECT h.* FROM olbia.asset_holdings h JOIN olbia.asset_captures c ON c.id=h.capture_id WHERE c.owner=$1 ORDER BY h.capture_id,h.position', [owner]),
    client.query('SELECT d.* FROM olbia.asset_daily_captures d JOIN olbia.asset_captures c ON c.id=d.capture_id WHERE c.owner=$1', [owner]),
    client.query('SELECT r.* FROM olbia.asset_capture_replacements r JOIN olbia.asset_captures c ON c.id=r.previous_capture_id WHERE c.owner=$1', [owner]),
    client.query('SELECT * FROM olbia.liability_captures WHERE owner=$1 ORDER BY id', [owner]),
    client.query('SELECT d.* FROM olbia.liability_daily_captures d JOIN olbia.liability_captures c ON c.id=d.capture_id WHERE c.owner=$1', [owner]),
    client.query('SELECT r.* FROM olbia.liability_capture_replacements r JOIN olbia.liability_captures c ON c.id=r.previous_capture_id WHERE c.owner=$1', [owner]),
    client.query('SELECT * FROM olbia.card_profiles WHERE owner=$1 AND deleted_at IS NULL', [owner]),
    client.query("SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace AND conname=ANY($1::text[]) ORDER BY conname", [[...requiredRelations]]),
  ]);
  let mismatches = 0;
  const check = (expected: unknown, actual: unknown) => { mismatches += Number(!samePublicResult(expected, actual)); };
  check([...requiredRelations].sort().map(conname => ({ conname, convalidated: true })), constraints.rows);
  check(['nu_cajita_emergencia', 'bitso', 'ibkr'], accounts.rows.map(r => r.id));
  check([0, 1, 2], accounts.rows.map(r => Number(r.position)));
  const evidence = (r: JsonObject) => ({ bucket: String(r.evidence_bucket), key: String(r.evidence_key),
    sha256: String(r.evidence_sha256), contentType: 'application/json' as const });
  const assetFacts = new Map<string, WealthSnapshot>();
  for (const r of assets.rows) {
    const children = holdings.rows.filter(h => h.capture_id === r.id);
    check(children.map((_, i) => i), children.map(h => h.position));
    check(children.length, new Set(children.map(h => h.id)).size);
    const positions: WealthHolding[] = children.map(h => ({ id: String(h.id), symbol: String(h.symbol), name: String(h.name),
      quantity: Number(h.quantity), currency: String(h.currency), valueNativeMinor: money(h.value_native_minor), valueMxnMinor: money(h.value_mxn_minor) }));
    const total = children.reduce((sum, h) => sum + BigInt(String(h.value_mxn_minor)), 0n);
    assetFacts.set(String(r.id), { accountId: r.account_id as WealthSnapshot['accountId'], day: day(r.day), capturedAt: iso(r.captured_at),
      source: r.source as WealthSnapshot['source'], currency: 'MXN', totalMxnMinor: money(total), holdings: positions, evidence: evidence(r),
      ...(r.fx_rate == null ? {} : { fxRate: Number(r.fx_rate) }), ...(r.fx_source == null ? {} : { fxSource: String(r.fx_source) }) });
  }
  const liabilityFacts = new Map<string, CardLiabilitySnapshot>(liabilities.rows.map(r => [String(r.id), {
    cardId: String(r.card_id), day: day(r.day), capturedAt: iso(r.captured_at), source: 'manual', currency: 'MXN',
    totalMxnMinor: money(r.amount_mxn_minor), evidence: evidence(r),
  }]));
  const verifySelection = (parents: JsonObject[], pointers: JsonObject[], edges: JsonObject[], identity: 'account_id' | 'card_id') => {
    const byId = new Map(parents.map(r => [r.id, r])), next = new Map(edges.map(r => [r.previous_capture_id, r.replacement_capture_id]));
    for (const r of parents) {
      const pointer = pointers.find(p => p[identity] === r[identity] && day(p.day) === day(r.day));
      check(true, !!pointer);
      check(true, (pointer?.capture_id === r.id) !== next.has(r.id));
      const visited = new Set(); let current = r.id;
      while (next.has(current)) {
        if (visited.has(current)) { mismatches++; break; }
        visited.add(current); current = next.get(current);
        const target = byId.get(current);
        check(true, !!target && target[identity] === r[identity] && day(target.day) === day(r.day) && target.owner === r.owner);
      }
      check(pointer?.capture_id, current);
    }
    check(parents.length, pointers.length + edges.length);
  };
  verifySelection(assets.rows, assetDays.rows, assetEdges.rows, 'account_id');
  verifySelection(liabilities.rows, liabilityDays.rows, liabilityEdges.rows, 'card_id');
  const definitions: WealthAccountDefinition[] = accounts.rows.map(r => ({ id: r.id as WealthAccountDefinition['id'], name: String(r.name),
    institution: String(r.institution), role: r.role as WealthAccountDefinition['role'], sync: r.sync as WealthAccountDefinition['sync'] }));
  definitions.splice(1, 0, WEALTH_ACCOUNTS.find(a => a.id === FONDO_AHORRO_ACCOUNT_ID)!);
  const inputs: NativeWealthInputs = { accounts: definitions,
    snapshots: assetDays.rows.map(r => assetFacts.get(String(r.capture_id))!).sort((a, b) => a.day.localeCompare(b.day) || a.accountId.localeCompare(b.accountId)),
    liabilitySnapshots: liabilityDays.rows.map(r => liabilityFacts.get(String(r.capture_id))!).sort((a, b) => a.day.localeCompare(b.day) || a.cardId.localeCompare(b.cardId)),
    cards: cards.rows.map(r => ({ id: String(r.id), name: String(r.name), cutOffDay: Number(r.cut_off_day), paymentDueDay: Number(r.payment_due_day),
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), ...(r.institution == null ? {} : { institution: r.institution as NativeWealthInputs['cards'][number]['institution'] }) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id)),
  };
  const audit: NativeWealthAudit[] = [
    ...assetEdges.rows.map(r => ({ kind: 'asset' as const, captureId: String(r.previous_capture_id), replacedByCaptureId: String(r.replacement_capture_id),
      replacedAt: assetFacts.get(String(r.replacement_capture_id))!.capturedAt, snapshot: assetFacts.get(String(r.previous_capture_id))! })),
    ...liabilityEdges.rows.map(r => ({ kind: 'liability' as const, captureId: String(r.previous_capture_id), replacedByCaptureId: String(r.replacement_capture_id),
      replacedAt: liabilityFacts.get(String(r.replacement_capture_id))!.capturedAt, snapshot: liabilityFacts.get(String(r.previous_capture_id))! })),
  ].sort((a, b) => a.snapshot.capturedAt.localeCompare(b.snapshot.capturedAt) || a.captureId.localeCompare(b.captureId));
  return { inputs, audit, assetFacts, liabilityFacts,
    mismatches, captures: assets.rows.length + liabilities.rows.length, holdings: holdings.rows.length,
    replacements: audit.length, validatedConstraints: constraints.rows.filter(r => r.convalidated === true).length };
};

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

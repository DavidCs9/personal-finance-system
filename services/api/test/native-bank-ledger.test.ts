import { createHash, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMsiSchedule } from '@finance/domain';
import { nativeFixture } from './fixtures/native-ledger.js';
import { currentSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import { readLedgerDetail } from '../../ledger/src/dsql/ledger-reads.js';
import { appendLedgerObservation, insertLedgerRevision } from '../../ledger/src/dsql/ledger-writes.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import type { BankImportKind, BankImportRecord } from '../src/imports/import-sql.js';
import type { StatementPreviewRow } from '../src/imports/statement-reconciliation.js';
import * as readers from '../src/events/sql-reads.js';
const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let imports: typeof import('../src/imports/import-sql.js');
let shared: typeof import('../src/imports/statement-shared.js');
let bank: typeof import('../src/imports/bank-ledger.js');
let csvFlow: typeof import('../src/imports/santander-csv-flow.js');
let csvParser: typeof import('../src/imports/santander-csv.js');
let edits: typeof import('../src/events/mutations.js');
const at = '2026-08-01T12:00:00.123Z';
const row: StatementPreviewRow = { identity: 'bank-original', kind: 'purchase', merchantRaw: 'Original shop',
  amountMinor: 10000, occurredOn: '2026-08-01', status: 'new', candidateEventIds: [], candidates: [], msi: false };
const csv = `No. de Tarjeta: 4262**1234
Producto: UNIQUE REWARDS PLATINUM V
TASA DE INTERÉS ANUALIZADA: 56.46 %
Detalle del 01/ago/2026 al 02/ago/2026,Total de movimientos: 1
FECHA,CONSECUTIVO,CONCEPTO,IMPORTE
01/Ago/2026,2621340486795734,ORIGINAL PURCHASE,$ 1.00`;
beforeAll(async () => {
  vi.stubEnv('METADATA_TABLE_NAME', 'metadata'); vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence'); vi.stubEnv('OLBIA_SQL_STORE_ENABLED', 'true');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  imports = await import('../src/imports/import-sql.js'); shared = await import('../src/imports/statement-shared.js');
  bank = await import('../src/imports/bank-ledger.js'); csvFlow = await import('../src/imports/santander-csv-flow.js');
  csvParser = await import('../src/imports/santander-csv.js'); edits = await import('../src/events/mutations.js');
}, 30_000);
beforeEach(async () => { await fixture.reset(); vi.spyOn(readers, 'readerPool').mockImplementation(() => currentSqlClient() ?? fixture.pool); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
const save = async (kind: BankImportKind, rows: BankImportRecord['rows'], importId = 'a'.repeat(64)) => {
  const record: BankImportRecord = { kind, importId, owner: 'owner', status: 'previewed', createdAt: at, previewedAt: at,
    accountLastFour: '1234', product: 'Original product', period: { from: '2026-08-01', to: '2026-08-31' },
    source: { bucket: 'evidence', key: `${importId}.original`, sha256: importId,
      contentType: kind === 'santander_csv' ? 'text/csv' : 'application/pdf' }, rows };
  return imports.startBankImport(record);
};
const apply = (record: BankImportRecord, rows: readonly StatementPreviewRow[], decisionBody?: string,
  afterRows?: () => Promise<{ readonly deferredMsi: number }>) => shared.applyStatementImport({
    provider: record.kind === 'amex_statement' ? 'amex' : 'santander', importId: record.importId, owner: record.owner,
    decisionBody, prepareRows: async () => ({ rebuildRows: async () => rows, afterRows }),
  });
const budgetRows = (count: number): StatementPreviewRow[] => Array.from({ length: count }, (_, i) => ({ ...row,
  identity: `budget-plan-${i}`, kind: 'msi', msi: true, merchantRaw: `Budget ${String(i).padStart(2, '0')} purchase`,
  amountMinor: 10000 + i * 10000, installmentIndex: 1, installmentMonths: 48,
  originalAmountMinor: (10000 + i * 10000) * 48, status: 'needs_decision' }));
const planDecisions = (rows: readonly StatementPreviewRow[]) => JSON.stringify({ decisions: Object.fromEntries(rows.map(r =>
  [r.identity, { action: 'create_plan', months: 48, cuotaMinor: r.amountMinor }])) });

describe('native bank financial authority and exact provenance', () => {
  it.each(['amex_statement', 'santander_statement'] as const)('%s rejects a whole over-budget MSI apply and permits a smaller retry', async kind => {
    const rows = budgetRows(59), record = await save(kind, rows);
    const before = await fixture.snapshot();
    await expect(apply(record, rows, planDecisions(rows))).rejects.toThrow('demasiadas filas');
    expect(await fixture.snapshot()).toEqual(before);
    expect(await imports.readBankImport(kind, record.importId, record.owner)).toEqual(record);
    // Every omitted row is now an explicit, literal skip; incomplete decisions cannot silently complete an import.
    const decisions = JSON.stringify({ decisions: Object.fromEntries(rows.map((r,i) => [r.identity,
      i === 0 ? {action:'create_plan',months:48,cuotaMinor:r.amountMinor} : {action:'skip'}])) });
    expect(await apply(record, rows, decisions)).toMatchObject({ summary: { created: 1, skipped: 58 } });
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_entries')).rows).toHaveLength(48);
  }, 20_000);

  it('CSV rejects an over-budget plan apply with unchanged preview, source assertions and financial history', async () => {
    const sourceBody = csv.replace('Total de movimientos: 1', 'Total de movimientos: 59').replace(
      '01/Ago/2026,2621340486795734,ORIGINAL PURCHASE,$ 1.00', Array.from({ length: 59 }, (_, i) =>
        `01/Ago/2026,${2621340486795000 + i},AMAZON A MESES,$ ${100 + i * 100}.00`).join('\n'));
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: { transformToString: async () => sourceBody } } as never);
    const preview = await csvFlow.previewSantanderImport(sourceBody, 'owner');
    const rows = preview.rows as StatementPreviewRow[];
    expect(rows).toHaveLength(59);
    const record = await imports.readBankImport('santander_csv', String(preview.importId), 'owner');
    const before = await fixture.snapshot();
    await expect(csvFlow.applySantanderImport(String(preview.importId), 'owner', planDecisions(rows))).rejects.toThrow('demasiadas filas');
    expect(await fixture.snapshot()).toEqual(before);
    expect(await imports.readBankImport('santander_csv', String(preview.importId), 'owner')).toEqual(record);
  }, 20_000);

  it('includes Amex deferral warning replacements in the same budget and rolls back earlier plan creations', async () => {
    const purchase = await fixture.create({ parseWarnings: Array.from({ length: 500 }, (_, i) => `Original warning ${i}`) });
    const rows = budgetRows(39), record = await save('amex_statement', rows);
    const before = await fixture.snapshot();
    await expect(apply(record, rows, planDecisions(rows), async () => ({
      deferredMsi: Number(await edits.markDeferredMsi(purchase, 'owner', 'actual-deferral')),
    }))).rejects.toThrow('demasiadas filas');
    expect(await fixture.snapshot()).toEqual(before);
    expect((await imports.readBankImport(record.kind, record.importId, record.owner))!.status).toBe('previewed');
  }, 20_000);

  it('reserves final import completion and rolls back a financial transaction that otherwise exactly fills the row budget', async () => {
    const record = await save('amex_statement', [row]);
    const before = await fixture.snapshot();
    await expect(apply(record, [row], undefined, async () => {
      const id = String((await bank.bankLedgerEvents())[0].id);
      const client = currentSqlClient()!;
      await appendLedgerObservation(client, { id: randomUUID(), movementId: id, captureSource: 'amex_statement',
        observedAt: at, reconciliationAt: at, institution: 'american_express_mx', eventType: 'card_purchase',
        merchantRaw: 'Original shop', amount: { amountMinor: 10000, currency: 'MXN' }, source: record.source,
        parserVersion: 'retained-parser', parseWarnings: Array.from({ length: 2994 }, (_, i) => `Source diagnostic ${i}`) });
      await insertLedgerRevision(client, { id: randomUUID(), movementId: id, createdAt: at, changedBy: 'owner', changes: {} });
      return { deferredMsi: 0 };
    })).rejects.toThrow('demasiadas filas');
    expect(await fixture.snapshot()).toEqual(before);
    expect(await imports.readBankImport(record.kind, record.importId, record.owner)).toEqual(record);
  }, 20_000);

  it('gives a near-limit successful apply a fresh budget on provider callback retry', async () => {
    const rows = budgetRows(57), record = await save('santander_statement', rows);
    const original = fixture.pool.transaction.bind(fixture.pool); let attempts = 0;
    vi.spyOn(fixture.pool, 'transaction').mockImplementation(async fn => {
      try { return await original(async client => { attempts++; const result = await fn(client);
        if (attempts === 1) throw new Error('Simulated OCC retry'); return result; }); }
      catch (error) { if (attempts !== 1) throw error; return original(async client => { attempts++; return fn(client); }); }
    });
    expect(await apply(record, rows, planDecisions(rows))).toMatchObject({ summary: { created: 57, skipped: 0 } });
    expect(attempts).toBe(2);
    expect((await fixture.sql.query('SELECT * FROM olbia.ledger_movements')).rows).toHaveLength(57);
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_entries')).rows).toHaveLength(57 * 48);
    expect((await imports.readBankImport(record.kind, record.importId, record.owner))!.status).toBe('applied');
  }, 20_000);

  it.each(['amex_statement', 'santander_statement', 'santander_csv'] as const)('%s links original gross evidence without changing personal zero or annotations', async kind => {
    const id = await fixture.create({ institution: kind === 'amex_statement' ? 'american_express_mx' : 'santander_mx',
      occurredAt: at, personalAmountMinor: 0, tags: ['shared'], categoryId: 'shopping' });
    const original = (await readLedgerDetail(fixture.pool, id))!.observations;
    const bankRow = { ...row, ...(kind === 'santander_csv' ? { rowNumber: 1, transactionId: 'bank-id' } : {}) };
    const record = await save(kind, [bankRow]);
    const input = { record, row: bankRow, eventId: id, appliedAt: at, reason: 'Original bank reconciliation', parserVersion: 'original-bank' };
    expect(await bank.linkBankEvidence(input)).toBe(true);
    const detail = (await readLedgerDetail(fixture.pool, id))!;
    expect(detail).toMatchObject({ personalAmountMinor: 0, tags: ['shared'], categoryId: 'shopping', observationCount: 2,
      captureSources: ['email', kind], revisions: [{ reason: 'Original bank reconciliation' }] });
    expect((detail.observations as Record<string, unknown>[]).find(o => o.captureSource === 'email')).toEqual((original as unknown[])[0]);
    expect((detail.observations as Record<string, unknown>[]).find(o => o.captureSource === kind)).toMatchObject({ amount: { amountMinor: 10000, currency: 'MXN' } });
    const state = await fixture.snapshot(); expect(await bank.linkBankEvidence(input)).toBe(false);
    expect(await fixture.snapshot()).toEqual(state);
    expect((await fixture.sql.query('SELECT * FROM olbia.source_claims')).rows).toMatchObject([
      { capture_source: kind, token: bank.bankClaimToken(row.identity), movement_id: id, outcome: 'linked' },
    ]);
    expect((await fixture.sql.query('SELECT * FROM olbia.projection_state')).rows).toEqual([]);
  });

  it.each(['amex_statement', 'santander_statement'] as const)('%s creates a plan with original cuota distinct from canonical principal and exact bank-row FK', async kind => {
    const msiRow: StatementPreviewRow = { ...row, kind: 'msi', msi: true, merchantRaw: 'Original MSI shop', amountMinor: 3000,
      installmentIndex: 2, installmentMonths: 3, originalAmountMinor: 9000, status: 'needs_decision' };
    // Another capture has the same printed identity; only this import owns the confirmation.
    await save(kind, [msiRow], 'b'.repeat(64)); const record = await save(kind, [msiRow]);
    const result = await apply(record, [msiRow], JSON.stringify({ decisions: { [row.identity]: { action: 'create_plan', months: 3, cuotaMinor: 3000 } } }));
    expect(result).toMatchObject({ summary: { created: 1, linked: 0 } });
    const detail = (await readLedgerDetail(fixture.pool, String((result.created as Record<string, unknown>[])[0].id)))!;
    expect(detail).toMatchObject({ amount: { amountMinor: 9000 }, observations: [{ amount: { amountMinor: 3000 }, occurredAt: '2026-08-01T12:00:00.000Z' }],
      msi: { installments: [{ month: '2026-07' }, { month: '2026-08', evidenceObservationId: row.identity, status: 'spent' }, {}] } });
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_entries WHERE evidence_identity IS NOT NULL')).rows).toMatchObject([
      { installment_index: 2, evidence_origin: 'bank_row', evidence_import_kind: kind,
        evidence_content_sha256: record.importId, evidence_row_position: 0 },
    ]);
    const state = await fixture.snapshot(); expect(await apply(record, [])).toMatchObject({ alreadyApplied: true });
    expect(await fixture.snapshot()).toEqual(state);
  });

  it.each(['amex_statement', 'santander_statement'] as const)('%s confirms an existing plan against the selected import, preserving original capture', async kind => {
    const plan = buildMsiSchedule({ principalMinor: 9000, months: 3, cuotaMinor: 3000, startMonth: '2026-08', origin: 'manual' });
    const institution = kind === 'amex_statement' ? 'american_express_mx' : 'santander_mx';
    const id = await fixture.create({ msi: plan, merchantRaw: 'Original MSI shop', institution,
      account:{institution,lastFour:'1234'} });
    const original = (await readLedgerDetail(fixture.pool, id))!.observations;
    const msiRow: StatementPreviewRow = { ...row, kind: 'msi', msi: true, merchantRaw: 'Original MSI shop', amountMinor: 3000,
      installmentIndex: 1, installmentMonths: 3, originalAmountMinor: 9000, status: 'matched', eventId: id, candidateEventIds: [id] };
    const record = await save(kind, [msiRow]);
    expect(await apply(record, [msiRow])).toMatchObject({ summary: { created: 0, linked: 1, msiConfirmed: 1 } });
    const detail = (await readLedgerDetail(fixture.pool, id))!; expect(detail.observations).toEqual(original);
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_entries WHERE evidence_identity IS NOT NULL')).rows).toMatchObject([
      { movement_id: id, evidence_origin: 'bank_row', evidence_import_kind: kind, evidence_content_sha256: record.importId, evidence_row_position: 0 },
    ]);
  });

  it.each(['existing', 'new'] as const)('CSV %s plan apply preserves original cuota and exact row provenance through the real public flow', async mode => {
    const sourceBody = csv.replace('ORIGINAL PURCHASE', 'AMAZON A MESES');
    const id = mode === 'existing' ? await fixture.create({ merchantRaw: 'AMAZON A MESES',
      account:{institution:'santander_mx',lastFour:'1234'}, msi: buildMsiSchedule({
      principalMinor: 300, months: 3, cuotaMinor: 100, startMonth: '2026-08', origin: 'manual',
    }) }) : undefined;
    const original = id ? (await readLedgerDetail(fixture.pool, id))!.observations : undefined;
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: { transformToString: async () => sourceBody } } as never);
    const preview = await csvFlow.previewSantanderImport(sourceBody, 'owner');
    const previewRow = (preview.rows as { identity: string }[])[0];
    const result = await csvFlow.applySantanderImport(String(preview.importId), 'owner', mode === 'new'
      ? JSON.stringify({ decisions: { [previewRow.identity]: { action: 'create_plan', months: 3, cuotaMinor: 100, startMonth: '2026-08' } } })
      : undefined);
    expect(result).toMatchObject({ summary: { created: mode === 'new' ? 1 : 0, msiConfirmed: mode === 'existing' ? 1 : 0 } });
    const movementId = id ?? String((result.created as Record<string, unknown>[])[0].id);
    const detail = (await readLedgerDetail(fixture.pool, movementId))!;
    if (original) {
      expect((detail.observations as Record<string, unknown>[]).filter(o => o.captureSource === 'email')).toEqual(original);
      expect((detail.observations as Record<string, unknown>[]).find(o => o.captureSource === 'santander_csv'))
        .toMatchObject({ amount: { amountMinor: 100 } });
    }
    else expect(detail).toMatchObject({ amount: { amountMinor: 300 }, observations: [{ amount: { amountMinor: 100 } }] });
    expect((await fixture.sql.query('SELECT * FROM olbia.installment_entries WHERE evidence_identity IS NOT NULL')).rows).toMatchObject([
      { movement_id: movementId, evidence_origin: 'bank_row', evidence_import_kind: 'santander_csv',
        evidence_content_sha256: preview.importId, evidence_row_position: 0, evidence_identity: previewRow.identity },
    ]);
  });

  it('preserves unexplained historical claim suppression and rejects invented or changed original rows', async () => {
    const record = await save('amex_statement', [row]);
    await fixture.sql.query(`INSERT INTO olbia.source_claims (capture_source,token,created_at,outcome,historical_target_id)
      VALUES ('amex_statement',$1,$2,'historical_missing',$3)`, [bank.bankClaimToken(row.identity), at, randomUUID()]);
    expect(await bank.claimedBankRows('amex_statement', [row.identity, 'unseen'])).toEqual(new Set([row.identity]));
    expect(await apply(record, [row])).toMatchObject({ summary: { created: 0, skipped: 1 } });
    expect((await fixture.sql.query('SELECT * FROM olbia.ledger_movements')).rows).toEqual([]);
    expect(() => bank.bankRowPosition(record, { ...row, amountMinor: 9999 })).toThrow('evidencia');
    expect(() => bank.bankRowPosition(record, { ...row, identity: 'invented' })).toThrow('evidencia');
  });

  it('rolls back an Amex deferral failure before import completion and rechecks prepared import versions', async () => {
    const id = await fixture.create({ institution: 'american_express_mx', merchantRaw: 'Deferred original', amount: { amountMinor: 10000, currency: 'MXN' } });
    const record = await save('amex_statement', [row]); const baseline = await fixture.snapshot();
    await expect(apply(record, [row], undefined, async () => {
      await edits.markDeferredMsi(id, 'owner', 'original-credit'); throw new Error('Deferral interruption');
    })).rejects.toThrow('Deferral interruption');
    expect(await fixture.snapshot()).toEqual(baseline);
    expect((await imports.readBankImport(record.kind, record.importId, 'owner'))!.status).toBe('previewed');
    await expect(shared.applyStatementImport({ provider: 'amex', importId: record.importId, owner: 'owner', decisionBody: undefined,
      prepareRows: async () => {
        expect(currentSqlClient()).toBeUndefined();
        await fixture.sql.query('UPDATE olbia.bank_imports SET previewed_at=$1 WHERE content_sha256=$2', ['2026-08-02T12:00:00Z', record.importId]);
        return { rebuildRows: async () => [row] };
      },
    })).rejects.toThrow('importación cambió');
    expect(await fixture.snapshot()).toEqual(baseline);
  });

  it('loads CSV evidence once outside a retried transaction, then commits only one linked capture/claim', async () => {
    const importId = createHash('sha256').update(csv).digest('hex');
    const document = csvParser.parseSantanderCsv(csv);
    await save('santander_csv', document.rows.map(r => ({ ...r, status: 'new', candidateEventIds: [], candidates: [] })), importId);
    const source = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async () => {
      expect(currentSqlClient()).toBeUndefined(); return { Body: { transformToString: async () => csv } };
    }) as never);
    const original = fixture.pool.transaction.bind(fixture.pool); let attempts = 0;
    vi.spyOn(fixture.pool, 'transaction').mockImplementation(async fn => {
      try { return await original(async client => { attempts++; const result = await fn(client);
        if (attempts === 1) throw new Error('Simulated OCC retry'); return result; }); }
      catch (error) { if (attempts !== 1) throw error; return original(async client => { attempts++; return fn(client); }); }
    });
    expect(await csvFlow.applySantanderImport(importId, 'owner', undefined)).toMatchObject({ summary: { created: 1 } });
    expect(source).toHaveBeenCalledOnce(); expect(attempts).toBe(2);
    for (const table of ['ledger_movements', 'ledger_observations', 'source_claims'])
      expect((await fixture.sql.query(`SELECT * FROM olbia.${table}`)).rows).toHaveLength(1);
  });
});

const printedMsiRow = (changes: Partial<StatementPreviewRow> = {}): StatementPreviewRow => ({
  ...row, identity:'printed-quota', kind:'msi', msi:true, merchantRaw:'AMAZON A MESES',
  amountMinor:3000, occurredOn:'2026-10-04', originalOn:'2026-09-30',
  installmentIndex:1, installmentMonths:3, originalAmountMinor:9000, status:'new', ...changes,
});
const bankScope = {institution:'santander_mx',accountLastFour:'1234'};

describe('automatic statement decisions and stable native plan identity', () => {
  it('creates a complete printed plan without a decision and preserves literal principal, source and replay', async () => {
    const printed = printedMsiRow({originalAmountMinor:9001}), record=await save('santander_statement',[printed]);
    const result=await apply(record,[printed]);
    expect(result).toMatchObject({summary:{created:1,linked:0,skipped:0}});
    const event=(await readLedgerDetail(fixture.pool,String((result.created as Record<string,unknown>[])[0].id)))!;
    expect(event).toMatchObject({amount:{amountMinor:9001},msi:{principalMinor:9001,months:3,
      installments:[{month:'2026-10',status:'spent',amountMinor:3000},{month:'2026-11',status:'committed'},{}]}});
    const before=await fixture.snapshot();
    expect(await apply(record,[printed])).toMatchObject({alreadyApplied:true});
    expect(await fixture.snapshot()).toEqual(before);
  });

  it('reuses one purchase through later monthly bank-row FKs even after the visible merchant was renamed', async () => {
    const first=printedMsiRow(), firstRecord=await save('santander_statement',[first]);
    const result=await apply(firstRecord,[first]);
    const id=String((result.created as Record<string,unknown>[])[0].id);
    await fixture.sql.query("UPDATE olbia.ledger_movements SET merchant_raw='Mi dron' WHERE id=$1",[id]);
    for (const [index,month,hash] of [[2,'2026-11','b'],[3,'2026-12','c']] as const) {
      const printed=printedMsiRow({identity:`quota-${index}`,installmentIndex:index,occurredOn:`${month}-04`});
      const events=await bank.bankLedgerEvents();
      expect(events.find(event=>event.id===id)).toMatchObject({bankMsiAssertions:[{accountLastFour:'1234',merchantRaw:first.merchantRaw}]});
      const classified=shared.classifyMsiEvidenceRow(printed,events,bankScope);
      expect(classified).toMatchObject({status:'matched',eventId:id});
      const record=await save('santander_statement',[classified],hash.repeat(64));
      expect(await apply(record,[classified])).toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
    }
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([{id}]);
    expect((await fixture.sql.query('SELECT evidence_content_sha256 FROM olbia.installment_entries ORDER BY installment_index')).rows)
      .toEqual([{evidence_content_sha256:'a'.repeat(64)},{evidence_content_sha256:'b'.repeat(64)},{evidence_content_sha256:'c'.repeat(64)}]);
  });

  it.each([
    {institution:'american_express_mx',lastFour:'1234',currency:'MXN'},
    {institution:'santander_mx',lastFour:'5678',currency:'MXN'},
    {institution:'santander_mx',lastFour:'1234',currency:'USD'},
  ])('does not link matching amounts from another bank/card/currency: %o', async input => {
    const plan=buildMsiSchedule({principalMinor:9000,months:3,cuotaMinor:3000,startMonth:'2026-10',origin:'manual'});
    await fixture.create({institution:input.institution,account:{institution:input.institution,lastFour:input.lastFour},
      amount:{amountMinor:9000,currency:input.currency},merchantRaw:'AMAZON A MESES',msi:plan});
    expect(shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),bankScope))
      .toMatchObject({status:'new',candidateEventIds:[]});
  });

  it('blocks a new plan when a dated manual estimate has no card identity and a contradictory principal', async () => {
    const plan=buildMsiSchedule({principalMinor:8940,months:3,cuotaMinor:2980,startMonth:'2026-10',origin:'manual'});
    const id=await fixture.create({institution:'santander_mx',merchantRaw:'Mi compra',occurredAt:'2026-09-30T12:00:00Z',
      amount:{amountMinor:8940,currency:'MXN'},msi:plan});
    const classified=shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),bankScope);
    expect(classified).toMatchObject({status:'needs_decision',reason:'conflicting_msi_plan',candidateEventIds:[id],
      candidates:[{id,principalMinor:8940,cuotaMinor:2980,months:3,occurredAt:'2026-09-30T12:00:00.000Z'}]});
    const record=await save('santander_statement',[classified]);
    const before=await fixture.snapshot();
    await expect(apply(record,[classified])).rejects.toThrow('requiere revisión');
    await expect(apply(record,[classified],JSON.stringify({decisions:{[classified.identity]:{action:'create_plan',months:3,cuotaMinor:3000}}})))
      .rejects.toThrow('requiere revisión');
    expect(await fixture.snapshot()).toEqual(before);
    expect((await imports.readBankImport(record.kind,record.importId,record.owner))!.status).toBe('previewed');
    expect(await apply(record,[classified],JSON.stringify({decisions:{[classified.identity]:{action:'skip'}}})))
      .toMatchObject({summary:{created:0,linked:0,skipped:1}});
  });

  it('requires a listed decision for two compatible plans, then confirms one without creating a third', async () => {
    const plan=buildMsiSchedule({principalMinor:9000,months:3,cuotaMinor:3000,startMonth:'2026-10',origin:'manual'});
    const create=()=>fixture.create({institution:'santander_mx',account:{institution:'santander_mx',lastFour:'1234'},
      amount:{amountMinor:9000,currency:'MXN'},merchantRaw:'AMAZON A MESES',msi:plan});
    const [left,right]=[await create(),await create()];
    const classified=shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),bankScope);
    expect(classified).toMatchObject({status:'needs_decision',reason:'ambiguous_msi_match'});
    expect(new Set(classified.candidateEventIds)).toEqual(new Set([left,right]));
    const record=await save('santander_statement',[classified]);
    const before=await fixture.snapshot();
    await expect(apply(record,[classified])).rejects.toThrow('requiere revisión');
    expect(await fixture.snapshot()).toEqual(before);
    expect(await apply(record,[classified],JSON.stringify({decisions:{[classified.identity]:{action:'confirm_msi',eventId:left}}})))
      .toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toHaveLength(2);
  });

  it('rolls back the entire batch when an automatic new row acquired a plan after preview', async () => {
    const printed=printedMsiRow(), record=await save('santander_statement',[row,printed]);
    const plan=buildMsiSchedule({principalMinor:9000,months:3,cuotaMinor:3000,startMonth:'2026-10',origin:'manual'});
    await fixture.create({institution:'santander_mx',account:{institution:'santander_mx',lastFour:'1234'},
      amount:{amountMinor:9000,currency:'MXN'},merchantRaw:printed.merchantRaw,msi:plan});
    const current=shared.classifyMsiEvidenceRow(printed,await bank.bankLedgerEvents(),bankScope);
    expect(current.status).toBe('matched');
    const before=await fixture.snapshot();
    await expect(apply(record,[row,current])).rejects.toThrow('cambió desde la consulta');
    expect(await fixture.snapshot()).toEqual(before);
    expect((await imports.readBankImport(record.kind,record.importId,record.owner))!.status).toBe('previewed');
  });
});

it('keeps an Amex purchase reference across monthly statements and blocks a contradictory reference', async () => {
  const first=printedMsiRow({merchantReference:'BANKPURCHASE123'}), record=await save('amex_statement',[first]);
  const result=await apply(record,[first]);
  const id=String((result.created as Record<string,unknown>[])[0].id);
  const events=await bank.bankLedgerEvents();
  expect(events.find(event=>event.id===id)).toMatchObject({bankMsiAssertions:[{institution:'american_express_mx',merchantReference:'BANKPURCHASE123'}]});
  const next=printedMsiRow({identity:'next-quota',installmentIndex:2,occurredOn:'2026-11-04',merchantReference:'BANKPURCHASE123'});
  const scope={institution:'american_express_mx',accountLastFour:'1234'};
  expect(shared.classifyMsiEvidenceRow(next,events,scope)).toMatchObject({status:'matched',eventId:id});
  const conflict=shared.classifyMsiEvidenceRow({...next,merchantReference:'OTHERPURCHASE456'},events,scope);
  expect(conflict).toMatchObject({status:'needs_decision',reason:'conflicting_msi_plan',candidateEventIds:[id]});
});

const seedManualPlan = async (changes: {card?:string;status?:'accepted'|'needs_review'|'rejected';principal?:number;quota?:number} = {}) => {
  const id=randomUUID(),observation=randomUUID(),principal=changes.principal??8940,quota=changes.quota??2980;
  const plan=buildMsiSchedule({principalMinor:principal,months:3,cuotaMinor:quota,startMonth:'2026-09',origin:'manual'});
  const source={kind:'manual_entry',bucket:'evidence',key:'retained-manual.json',sha256:'d'.repeat(64),contentType:'application/json'};
  const account={institution:'american_express_mx',...(changes.card?{lastFour:changes.card}:{})};
  const ledger=await import('../../ledger/src/dsql/ledger-writes.js');
  await fixture.run(async()=>{
    await ledger.insertLedgerMovement(currentSqlClient()!,{id,institution:'american_express_mx',eventType:'card_purchase',
      status:changes.status??'accepted',amount:{amountMinor:principal,currency:'MXN'},merchantRaw:'Mi compra manual',
      occurredAt:'2026-09-30T12:00:00.000Z',receivedAt:'2026-09-30T12:00:00.000Z',ingestedAt:'2026-09-30T12:00:00.000Z',
      account,source,parserVersion:'manual-entry-v1',parseWarnings:[],tags:['compra:reloj'],categoryId:'shopping',msi:plan},
      observation,'2026-09-30T12:00:00.000Z');
    await ledger.appendLedgerObservation(currentSqlClient()!,{id:observation,movementId:id,captureSource:'manual',
      observedAt:'2026-09-30T12:00:00.000Z',reconciliationAt:'2026-09-30T12:00:00.000Z',
      institution:'american_express_mx',eventType:'card_purchase',amount:{amountMinor:principal,currency:'MXN'},
      merchantRaw:'Mi compra manual',occurredAt:'2026-09-30T12:00:00.000Z',account,source,parserVersion:'manual-entry-v1',parseWarnings:[]});
  });
  return id;
};

describe('one-time explicit manual plan reconciliation', () => {
  it('corrects one existing ID from printed bank terms and uses its FK/reference for future cuotas without another decision', async () => {
    const id=await seedManualPlan({status:'needs_review'}),before=(await readLedgerDetail(fixture.pool,id))!;
    const printed=printedMsiRow({merchantReference:'PURCHASEONE123'}),scope={institution:'american_express_mx',accountLastFour:'1234'};
    const classified=shared.classifyMsiEvidenceRow(printed,await bank.bankLedgerEvents(),scope);
    const candidate=classified.candidates.find(candidate=>candidate.id===id)!;
    expect(candidate).toMatchObject({canReconcilePlan:true,expectedPlan:{principalMinor:8940,cuotaMinor:2980,months:3,
      startMonth:'2026-09',occurredAt:'2026-09-30T12:00:00.000Z',accountLastFour:null}});
    const record=await save('amex_statement',[classified]);
    const decisions=JSON.stringify({decisions:{[classified.identity]:{action:'reconcile_plan',eventId:id,expectedPlan:candidate.expectedPlan}}});
    expect(await apply(record,[classified],decisions)).toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
    const corrected=(await readLedgerDetail(fixture.pool,id))!;
    expect(corrected).toMatchObject({id,merchantRaw:'Mi compra manual',status:'needs_review',tags:['compra:reloj'],categoryId:'shopping',
      amount:{amountMinor:9000,currency:'MXN'},account:{lastFour:'1234'},primaryObservationId:before.primaryObservationId,
      msi:{principalMinor:9000,cuotaMinor:3000,months:3,installments:[{month:'2026-10',status:'spent'},{month:'2026-11'},{month:'2026-12'}]}});
    expect((corrected.observations as Record<string,unknown>[]).find(item=>item.captureSource==='manual'))
      .toEqual((before.observations as Record<string,unknown>[])[0]);
    expect((corrected.observations as Record<string,unknown>[]).find(item=>item.captureSource==='amex_statement'))
      .toMatchObject({amount:{amountMinor:3000},merchantRaw:printed.merchantRaw,account:{lastFour:'1234'}});
    expect(corrected.bankTransactionId).toBeUndefined();
    expect((await fixture.sql.query('SELECT merchant_reference,bank_transaction_id FROM olbia.bank_import_rows')).rows)
      .toContainEqual({merchant_reference:'PURCHASEONE123',bank_transaction_id:null});
    expect((corrected.revisions as Record<string,unknown>[]).some(revision=>
      (revision.changes as Record<string,unknown>).amount && (revision.changes as Record<string,unknown>).msi)).toBe(true);
    const replay=await fixture.snapshot();expect(await apply(record,[classified],decisions)).toMatchObject({alreadyApplied:true});
    expect(await fixture.snapshot()).toEqual(replay);
    const next=printedMsiRow({identity:'next-print',installmentIndex:2,occurredOn:'2026-11-04',merchantReference:'PURCHASEONE123'});
    const nextClassified=shared.classifyMsiEvidenceRow(next,await bank.bankLedgerEvents(),scope);
    expect(nextClassified).toMatchObject({status:'matched',eventId:id});
    const nextRecord=await save('amex_statement',[nextClassified],'b'.repeat(64));
    expect(await apply(nextRecord,[nextClassified])).toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
    expect((await fixture.sql.query('SELECT id FROM olbia.ledger_movements')).rows).toEqual([{id}]);
  });

  it('rejects a stale expected plan atomically, including purchases earlier in the same batch', async () => {
    const id=await seedManualPlan(),scope={institution:'american_express_mx',accountLastFour:'1234'};
    const classified=shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),scope);
    const expected=classified.candidates.find(candidate=>candidate.id===id)!.expectedPlan;
    const record=await save('amex_statement',[row,classified]);
    await fixture.sql.query('UPDATE olbia.installment_plans SET cuota_minor=2981 WHERE movement_id=$1',[id]);
    const current=shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),scope);
    const before=await fixture.snapshot();
    await expect(apply(record,[row,current],JSON.stringify({decisions:{[current.identity]:{action:'reconcile_plan',eventId:id,expectedPlan:expected}}})))
      .rejects.toThrow('plan manual cambió');
    expect(await fixture.snapshot()).toEqual(before);
    expect((await imports.readBankImport(record.kind,record.importId,record.owner))!.status).toBe('previewed');
  });

  it.each([{card:'5678'}, {status:'rejected' as const}])('does not offer a manual correction for incompatible current capture: %o', async changes => {
    const id=await seedManualPlan(changes);
    const classified=shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),{institution:'american_express_mx',accountLastFour:'1234'});
    expect(classified.candidates.find(candidate=>candidate.id===id)?.canReconcilePlan).not.toBe(true);
  });
  it.each(['amount','calendar','bank_candidate'])('does not offer an operation the native writer must reject: %s',async defect=>{
    const id=await seedManualPlan();
    if(defect==='amount')await fixture.sql.query('UPDATE olbia.ledger_movements SET amount_minor=8941 WHERE id=$1',[id]);
    if(defect==='calendar')await fixture.sql.query("UPDATE olbia.installment_entries SET month='2026-07' WHERE movement_id=$1 AND installment_index=1",[id]);
    if(defect==='bank_candidate') {
      const record=await save('amex_statement',[printedMsiRow()]);
      await fixture.sql.query(`INSERT INTO olbia.installment_evidence_candidates
        (movement_id,installment_index,import_kind,content_sha256,row_position) VALUES ($1,1,$2,$3,0)`,[id,record.kind,record.importId]);
    }
    const classified=shared.classifyMsiEvidenceRow(printedMsiRow(),await bank.bankLedgerEvents(),{institution:'american_express_mx',accountLastFour:'1234'});
    expect(classified.candidates.find(candidate=>candidate.id===id)?.canReconcilePlan).not.toBe(true);
  });
});

it('does not suppress another PDF by a legacy row label before checking purchase ambiguity', async () => {
  const plan=buildMsiSchedule({principalMinor:9000,months:3,cuotaMinor:3000,startMonth:'2026-10',origin:'amex_auto'});
  for(const merchant of ['PURCHASE ONE','PURCHASE TWO']) {
    await fixture.create({institution:'american_express_mx',account:{institution:'american_express_mx',lastFour:'1234'},
      amount:{amountMinor:9000,currency:'MXN'},merchantRaw:merchant,
      msi:{...plan,installments:plan.installments.map(item=>({...item,status:'spent' as const}))}});
  }
  await fixture.sql.query("UPDATE olbia.installment_entries SET evidence_identity='reused-row-label',evidence_origin='legacy_backfill',confirmed_at='2026-10-04T12:00:00Z' WHERE installment_index=1");
  const line=printedMsiRow({identity:'reused-row-label',merchantRaw:'MESES EN AUTOMÁTICO NACIONAL'});
  const classified=shared.classifyMsiEvidenceRow(line,await bank.bankLedgerEvents(),{institution:'american_express_mx',accountLastFour:'1234'});
  expect(classified).toMatchObject({status:'needs_decision',reason:'ambiguous_msi_match'});
  expect(classified.candidateEventIds).toHaveLength(2);
});

import { createHash, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMsiSchedule } from '@finance/domain';
import { nativeFixture } from './fixtures/native-ledger.js';
import { currentStoreTransaction } from '../../ledger/src/dsql/store.js';
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
beforeEach(async () => { await fixture.reset(); vi.spyOn(readers, 'readerPool').mockImplementation(() => currentStoreTransaction() ?? fixture.pool); });
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
  identity: `budget-plan-${i}`, kind: 'msi', msi: true, merchantRaw: `Budget purchase ${i}`,
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
    // Undecided rows remain skipped; printed n/N rows intentionally interpret explicit "skip" as accept-as-printed.
    const decisions = JSON.stringify({ decisions: { [rows[0].identity]: { action: 'create_plan', months: 48, cuotaMinor: rows[0].amountMinor } } });
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
      const client = currentStoreTransaction()!;
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
    const id = await fixture.create({ msi: plan, merchantRaw: 'Original MSI shop' });
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
    const id = mode === 'existing' ? await fixture.create({ merchantRaw: 'AMAZON A MESES', msi: buildMsiSchedule({
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
        expect(currentStoreTransaction()).toBeUndefined();
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
      expect(currentStoreTransaction()).toBeUndefined(); return { Body: { transformToString: async () => csv } };
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

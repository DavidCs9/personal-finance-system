import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMsiSchedule } from '@finance/domain';
import { nativeFixture } from './fixtures/native-ledger.js';
import { activityWorkbook, type ActivityTestRow } from './fixtures/amex-activity-workbook.js';
import { AMEX_ACTIVITY_CONTENT_TYPE, parseAmexActivity, activityDate } from '../src/imports/amex-activity.js';
import { currentSqlClient } from '../../ledger/src/dsql/sql-runtime.js';
import type { SqlClient, TransactionPool } from '../../ledger/src/dsql/projection.js';
import * as readers from '../src/events/sql-reads.js';
import type { BankImportRow } from '../src/imports/import-sql.js';
import { parseAmexStatementExtraction, type AmexStatementDocument } from '../src/imports/amex-statement.js';

const harness = vi.hoisted(() => ({ pool: undefined as unknown as SqlClient & TransactionPool }));
vi.mock('../../ledger/src/dsql/connection.js', () => ({ createPool: () => harness.pool }));
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let flow: typeof import('../src/imports/amex-activity-flow.js');
let imports: typeof import('../src/imports/import-sql.js');
let statements: typeof import('../src/imports/statement-shared.js');
let amex: typeof import('../src/imports/amex-statement-flow.js');
let reconciliation: typeof import('../src/imports/amex-reconciliation.js');
const originals = new Map<string, Uint8Array>();
const owner = 'owner', account = { institution: 'american_express_mx', lastFour: '3456' };
beforeAll(async () => {
  vi.stubEnv('RAW_EMAIL_BUCKET_NAME', 'evidence'); vi.stubEnv('METADATA_TABLE_NAME', 'metadata');
  fixture = await nativeFixture(); harness.pool = fixture.pool;
  flow = await import('../src/imports/amex-activity-flow.js'); imports = await import('../src/imports/import-sql.js');
  statements = await import('../src/imports/statement-shared.js'); amex = await import('../src/imports/amex-statement-flow.js');
  reconciliation = await import('../src/imports/amex-reconciliation.js');
}, 30_000);
beforeEach(async () => {
  await fixture.reset(); originals.clear();
  vi.spyOn(readers, 'readerPool').mockImplementation(() => currentSqlClient() ?? fixture.pool);
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    expect(currentSqlClient()).toBeUndefined();
    const bytes = originals.get(String((command as { input: { Key: string } }).input.Key));
    if (!bytes) throw Object.assign(new Error('Missing original'), { name: 'NoSuchKey' });
    return { ContentLength: bytes.length, ContentType: AMEX_ACTIVITY_CONTENT_TYPE,
      Body: { transformToByteArray: async () => bytes } };
  }) as never);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture.sql.close(); vi.unstubAllEnvs(); });
const previewBytes = async (bytes: Uint8Array) => {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  originals.set(`manual-imports/amex-activity/${owner}/${sha256}.xlsx`, bytes);
  return flow.previewAmexActivity(JSON.stringify({ sha256, size: bytes.length }), owner);
};
const preview = (rows: readonly ActivityTestRow[] = [{}], suffix = '23456') => previewBytes(activityWorkbook(rows, suffix));
const count = async (table = 'ledger_movements') => Number((await fixture.sql.query<{ n: number }>(`SELECT count(*) AS n FROM olbia.${table}`)).rows[0].n);
const apply = (id: string, decisions: unknown = {}) => flow.applyAmexActivity(id, owner, JSON.stringify({ decisions }));
const seed = (extra: Record<string, unknown> = {}) => fixture.create({ institution: 'american_express_mx', account,
  merchantRaw: 'Example shop', amount: { amountMinor: 59900, currency: 'MXN' }, occurredAt: '2026-10-14T12:00:00Z', ...extra });
const pdfDocument = (lines: readonly string[]): AmexStatementDocument => parseAmexStatementExtraction({
  provider: 'amex', jobId: 'original-job', status: 'SUCCEEDED', queryAnswers: [], tables: [], lines, text: lines.join('\n'),
  answers: { ACCOUNT_LAST_FOUR: '3456', PERIOD_FROM: '2026-10-07', PERIOD_TO: '2026-11-06', PRODUCT: 'Gold Elite American Express' },
});
const previewPdf = async (document: AmexStatementDocument) => {
  const rows = await amex.buildAmexPreviewRows(document, owner), importId = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const record=await imports.startBankImport({ kind: 'amex_statement', importId, owner, status: 'previewed', createdAt: '2026-11-07T12:00:00Z',
    previewedAt: '2026-11-07T12:00:00Z', accountLastFour: '3456', product: document.product, period: document.period,
    source: { bucket: 'evidence', key: `${importId}.pdf`, sha256: importId, contentType: 'application/pdf' }, rows });
  return {...record,rows};
};
const applyPdf = (importId: string, document: AmexStatementDocument, decisions: unknown = {}) => statements.applyStatementImport({
  provider: 'amex', conservativeAmex: true, importId, owner, decisionBody: JSON.stringify({ decisions }),
  prepareRows: async () => ({ rebuildRows: () => amex.buildAmexPreviewRows(document, owner) }),
});

describe('Amex activity parsing and native financial application', () => {
  it('reads exact cents, both dates, bank/merchant references and printed installment metadata', async () => {
    const document = await parseAmexActivity(activityWorkbook([{ amount: 586.75, date: '07 Oct 2026', purchaseDate: '08 Oct 2026',
      detail: 'CARGO 02 DE 12\nRFCEXAMPLE /REFmerchant-reference' }]));
    expect(document).toMatchObject({ accountLastFour: '3456', period: { from: '2026-10-07', to: '2026-11-06' },
      rows: [{ amountMinor: 58675, occurredOn: '2026-10-07', purchaseOn: '2026-10-08', kind: 'msi',
        installmentIndex: 2, installmentMonths: 12, transactionId: 'AT-bank-0', merchantReference: 'merchant-reference' }] });
    expect(activityDate('31 Ene 2026')).toBe('2026-01-31'); expect(() => activityDate('31 Feb 2026')).toThrow('fecha');
  });
  it('rejects missing/repeated references, invalid money, malformed dates and impossible MSI before storing financial data', async () => {
    for (const rows of [[{ reference: '' }], [{ reference: 'AT-same' }, { reference: 'AT-same' }], [{ amount: 0.001 }],
      [{ date: '31 Oct 2026', detail: 'CARGO 13 DE 12' }], [{ date: '31 Feb 2026' }]])
      await expect(preview(rows)).rejects.toThrow();
    expect(await count()).toBe(0);
  });
  it('survives identical retries, renamed/reordered/overlapping weekly files and preserves genuinely distinct equal purchases', async () => {
    const first = await preview([{ reference: 'AT-first' }]);
    expect(await apply(first.importId)).toMatchObject({ summary: { created: 1, linked: 0 } });
    expect(await apply(first.importId)).toMatchObject({ alreadyApplied: true, created: [] });
    const second = await preview([{ reference: 'AT-second' }, { reference: 'AT-first' }]);
    expect(second.rows.map(r => r.status)).toEqual(['new', 'duplicate']);
    expect(await apply(second.importId)).toMatchObject({ summary: { created: 1, skipped: 1 } });
    const reordered = await preview([{ reference: 'AT-first' }, { reference: 'AT-second' }]);
    expect(reordered.rows.every(r => r.status === 'duplicate')).toBe(true);
    expect(await apply(reordered.importId)).toMatchObject({ summary: { created: 0, linked: 0, skipped: 2 } });
    expect(await count()).toBe(2); expect(await count('source_claims')).toBe(2);
    expect(await count('ledger_observations')).toBe(2);
  });
  it('excludes payments and credits without reducing spending or counting source summary totals as movements', async () => {
    const p = await preview([{ amount: -4321.09 }, { amount: 599, reference: 'AT-charge' }]);
    expect(p.rows.map(r => r.status)).toEqual(['excluded', 'new']);
    expect(await apply(p.importId)).toMatchObject({ summary: { created: 1, skipped: 1 } });
    expect((await fixture.sql.query('SELECT amount_minor FROM olbia.ledger_movements')).rows).toEqual([{ amount_minor: 59900 }]);
  });
  it('links unique existing evidence while preserving Mi parte, tags and revisions', async () => {
    const id = await seed({ personalAmountMinor: 20000, tags: ['trip'] });
    const p = await preview(); expect(p.rows[0]).toMatchObject({ status: 'matched', eventId: id });
    expect(await apply(p.importId)).toMatchObject({ summary: { created: 0, linked: 1 } });
    expect(await count()).toBe(1); expect(await count('ledger_observations')).toBe(2);
    expect((await fixture.sql.query<{ personal_amount_minor: number }>('SELECT personal_amount_minor FROM olbia.ledger_movements')).rows[0].personal_amount_minor).toBe(20000);
    expect((await fixture.sql.query<{ tag: string }>('SELECT tag FROM olbia.ledger_tags')).rows[0].tag).toBe('trip');
  });
  it('requires decisions for multiple candidates, unknown cards and rejected records, and never crosses institutions/cards', async () => {
    const id = await seed(); await seed();
    const p = await preview(); expect(p.rows[0].status).toBe('ambiguous');
    const before = await fixture.snapshot(); await expect(apply(p.importId)).rejects.toThrow('cambiaron');
    expect(await fixture.snapshot()).toEqual(before);
    expect(await apply(p.importId, { [p.rows[0].identity]: { action: 'link', eventId: id } })).toMatchObject({ summary: { created: 0, linked: 1 } });
    await fixture.reset(); await seed({ institution: 'santander_mx' }); await seed({ account: { ...account, lastFour: '9999' } });
    expect((await preview()).rows[0].status).toBe('new');
    await fixture.reset(); await seed({ status: 'rejected' }); expect((await preview()).rows[0].status).toBe('ambiguous');
    await fixture.reset(); await seed({ account: undefined }); expect((await preview()).rows[0].status).toBe('ambiguous');
  });
  it('does not assign two same-day same-amount source rows to one existing purchase (real PDF duplicate-charge shape)', async () => {
    await seed(); const p = await preview([{ reference: 'AT-one' }, { reference: 'AT-two' }]);
    expect(p.rows.map(r => r.status)).toEqual(['ambiguous', 'ambiguous']);
    const id = p.rows[0].candidateEventIds[0];
    await expect(apply(p.importId, Object.fromEntries(p.rows.map(r => [r.identity, { action: 'link', eventId: id }])))).rejects.toThrow();
    expect(await count()).toBe(1); expect(await count('ledger_observations')).toBe(1);
  });
  it('detects conflicting reuse of a bank reference instead of silently creating another movement', async () => {
    const first = await preview(); await apply(first.importId);
    await expect(preview([{ amount: 600 }])).rejects.toThrow('datos diferentes');
    expect(await count()).toBe(1);
  });
  it('rolls back stale previews and reclassifies safely before allowing a retry', async () => {
    const p = await preview(); await seed(); const before = await fixture.snapshot();
    await expect(apply(p.importId)).rejects.toThrow('cambiaron'); expect(await fixture.snapshot()).toEqual(before);
    const refreshed = await preview(); expect(refreshed.rows[0].status).toBe('matched');
    expect(await apply(refreshed.importId)).toMatchObject({ summary: { created: 0, linked: 1 } });
  });
  it('confirms a current MSI cuota on the existing plan and claims its reference across overlapping files', async () => {
    const plan = buildMsiSchedule({ principalMinor: 300000, cuotaMinor: 100000, months: 3, startMonth: '2026-09', origin: 'manual' });
    const id = await seed({ amount: { amountMinor: 300000, currency: 'MXN' }, msi: plan, occurredAt: '2026-09-07T12:00:00Z' });
    const p = await preview([{ amount: 1000, date: '07 Oct 2026', detail: 'CARGO 02 DE 03' }]);
    expect(p.rows[0]).toMatchObject({ status: 'matched', eventId: id });
    expect(await apply(p.importId)).toMatchObject({ summary: { created: 0, linked: 1, msiConfirmed: 1 } });
    expect(await count()).toBe(1); expect(await count('installment_plans')).toBe(1);
    expect((await fixture.sql.query('SELECT status,evidence_import_kind FROM olbia.installment_entries WHERE installment_index=2')).rows)
      .toEqual([{ status: 'spent', evidence_import_kind: 'amex_activity' }]);
    const again = await preview([{ reference: 'AT-extra', amount: -1 }, { amount: 1000, date: '07 Oct 2026', detail: 'CARGO 02 DE 03', reference: 'AT-bank-0' }]);
    expect(again.rows[1].status).toBe('duplicate'); expect(await apply(again.importId)).toMatchObject({ summary: { created: 0, linked: 0 } });
  });
  it('never opens a new MSI plan while compatible plans remain ambiguous, including already-spent cuotas', async () => {
    const plan = buildMsiSchedule({ principalMinor: 300000, cuotaMinor: 100000, months: 3, startMonth: '2026-09', origin: 'manual' });
    await seed({ msi: plan, amount: { amountMinor: 300000, currency: 'MXN' } });
    await seed({ msi: plan, amount: { amountMinor: 300000, currency: 'MXN' } });
    const p = await preview([{ amount: 1000, detail: 'CARGO 02 DE 03' }]); expect(p.rows[0].status).toBe('needs_decision');
    await expect(apply(p.importId, { [p.rows[0].identity]: { action: 'create_plan', months: 3, cuotaMinor: 100000 } })).rejects.toThrow();
    expect(await count('installment_plans')).toBe(2);
  });
  it('creates a printed MSI plan only after explicit review and omits it literally when requested', async () => {
    const p = await preview([{ amount: 586.75, date: '07 Oct 2026', detail: 'CARGO 02 DE 12' }]);
    expect(p.rows[0].status).toBe('needs_decision');
    expect(await apply(p.importId, { [p.rows[0].identity]: { action: 'create_plan', months: 12, cuotaMinor: 58675 } })).toMatchObject({ summary: { created: 1 } });
    expect((await fixture.sql.query('SELECT month,status FROM olbia.installment_entries ORDER BY installment_index LIMIT 3')).rows)
      .toEqual([{ month: '2026-09', status: 'spent' }, { month: '2026-10', status: 'spent' }, { month: '2026-11', status: 'committed' }]);
    await fixture.reset(); const omit = await preview([{ detail: 'CARGO 02 DE 03' }]);
    expect(await apply(omit.importId, { [omit.rows[0].identity]: { action: 'skip' } })).toMatchObject({ summary: { created: 0, skipped: 1 } });
    expect(await count('installment_plans')).toBe(0);
  });
  it('commits only once under concurrent duplicate applies', async () => {
    const p = await preview(); const results = await Promise.all([apply(p.importId), apply(p.importId)]);
    expect(results.some(r => r.alreadyApplied)).toBe(true); expect(await count()).toBe(1); expect(await count('source_claims')).toBe(1);
  });
  it('rejects unknown/other-owner imports and tampered retained originals', async () => {
    const p = await preview(); await expect(flow.applyAmexActivity(p.importId, 'other-owner', undefined)).rejects.toThrow('seleccionar');
    const key = [...originals.keys()][0]; originals.set(key, activityWorkbook([{ amount: 100 }]));
    await expect(apply(p.importId)).rejects.toThrow('no coincide'); expect(await count()).toBe(0);
  });
  it.each(['xlsx-first', 'pdf-first'])('%s reconciles the same purchase across bank references, merchant references and either date', async order => {
    const document = pdfDocument(['Fecha y Detalle de las operaciones', '15 de Octubre Example shop', 'RFCEXAMPLE /REFmerchant-1', '599.00']);
    expect(document.charges).toHaveLength(1); expect(document.charges[0].merchantReference).toBe('merchant-1');
    const rows = [{ date: '14 Oct 2026', purchaseDate: '15 Oct 2026', detail: 'RFCEXAMPLE /REFmerchant-1' }];
    if (order === 'xlsx-first') {
      const p = await preview(rows); await apply(p.importId);
      const pdf = await previewPdf(document); expect(pdf.rows[0].status).toBe('matched');
      expect(await applyPdf(pdf.importId, document)).toMatchObject({ summary: { created: 0, linked: 1 } });
    } else {
      const pdf = await previewPdf(document); await applyPdf(pdf.importId, document);
      const p = await preview(rows); expect(p.rows[0].status).toBe('matched');
      expect(await apply(p.importId)).toMatchObject({ summary: { created: 0, linked: 1 } });
    }
    expect(await count()).toBe(1); expect(await count('ledger_observations')).toBe(2); expect(await count('source_claims')).toBe(2);
  });
  it.each(['xlsx-first', 'pdf-first'])('%s reconciles an MSI cuota without duplicating its plan or monthly spend', async order => {
    const document = pdfDocument(['Fecha y Detalle de las operaciones', '14 de Octubre Example shop', 'CARGO 02 DE 03', '1,000.00']);
    expect(document.charges[0]).toMatchObject({ msi: true, installmentIndex: 2, amountMinor: 100000 });
    const rows = [{ amount: 1000, detail: 'CARGO 02 DE 03' }];
    if (order === 'xlsx-first') {
      const p = await preview(rows); await apply(p.importId, { [p.rows[0].identity]: { action: 'create_plan', months: 3, cuotaMinor: 100000 } });
      const pdf = await previewPdf(document); expect(pdf.rows[0].status).toBe('matched');
      expect(await applyPdf(pdf.importId, document)).toMatchObject({ summary: { created: 0, linked: 1 } });
    } else {
      const pdf = await previewPdf(document); await applyPdf(pdf.importId, document, {
        [pdf.rows[0].identity]: { action: 'create_plan', months: 3, cuotaMinor: 100000 },
      });
      const p = await preview(rows); expect(p.rows[0].status).toBe('matched');
      expect(await apply(p.importId)).toMatchObject({ summary: { created: 0, linked: 1 } });
    }
    expect(await count('installment_plans')).toBe(1); expect(await count()).toBe(1); expect(await count('ledger_observations')).toBe(2);
    expect(Number((await fixture.sql.query<{ amount: string }>("SELECT sum(amount_minor) AS amount FROM olbia.installment_entries WHERE month='2026-10' AND status='spent'")).rows[0].amount)).toBe(100000);
  });
  it('keeps equal genuine PDF purchases separate and blocks one-to-many automatic reconciliation', async () => {
    const document = pdfDocument(['Fecha y Detalle de las operaciones', '14 de Octubre Example shop', '599.00',
      '14 de Octubre Example shop', '599.00']);
    expect(document.charges).toHaveLength(2);
    const pdf = await previewPdf(document); await applyPdf(pdf.importId, document); expect(await count()).toBe(2);
    const p = await preview([{ reference: 'AT-one' }, { reference: 'AT-two' }]);
    expect(p.rows.map(row => row.status)).toEqual(['ambiguous', 'ambiguous']);
    const ids = p.rows[0].candidateEventIds;
    expect(await apply(p.importId, Object.fromEntries(p.rows.map((row, i) => [row.identity, { action: 'link', eventId: ids[i] }]))))
      .toMatchObject({ summary: { created: 0, linked: 2 } }); expect(await count()).toBe(2);
    await fixture.reset(); const xlsx = await preview(); await apply(xlsx.importId);
    const later = await previewPdf(document); expect(later.rows.map(r => r.status)).toEqual(['ambiguous', 'ambiguous']);
    const target = later.rows[0].candidateEventIds[0];
    await expect(applyPdf(later.importId, document, Object.fromEntries(later.rows.map(row => [row.identity,
      { action: 'link', eventId: target }])))).rejects.toThrow('misma compra'); expect(await count()).toBe(1);
  });
  it('loads immutable XLSX once across an OCC retry and commits just one capture', async () => {
    const p = await preview(); const original = fixture.pool.transaction.bind(fixture.pool); let attempts = 0;
    vi.spyOn(fixture.pool, 'transaction').mockImplementation(async fn => {
      try { return await original(async client => { attempts++; const result = await fn(client);
        if (attempts === 1) throw new Error('OCC retry'); return result; }); }
      catch (error) { if (attempts !== 1) throw error; return original(async client => { attempts++; return fn(client); }); }
    });
    const send = vi.mocked(S3Client.prototype.send); send.mockClear();
    expect(await apply(p.importId)).toMatchObject({ summary: { created: 1 } }); expect(attempts).toBe(2); expect(send).toHaveBeenCalledOnce();
    expect(await count()).toBe(1); expect(await count('source_claims')).toBe(1);
  });
  it('refuses automatic-deferral adjustments before saving a preview or changing finances', async () => {
    await expect(preview([{ merchant: 'MONTO A DIFERIR MESES EN AUTOMATICO', amount: -3000 }])).rejects.toThrow('Importa el PDF');
    expect(await count('bank_imports')).toBe(0); expect(await count()).toBe(0);
  });
  it('never turns a generic automatic quota without i/N into a purchase or inferred plan', async () => {
    const p = await preview([{ merchant: 'MESES EN AUTOMÁTICO', amount: 1000 }]);
    expect(p.rows[0]).toMatchObject({ kind: 'msi', status: 'needs_decision' });
    await expect(apply(p.importId, { [p.rows[0].identity]: { action: 'create' } })).rejects.toThrow('Vuelve a revisar');
    expect(await count()).toBe(0);
    expect(await apply(p.importId, { [p.rows[0].identity]: { action: 'skip' } })).toMatchObject({ summary: { created: 0, skipped: 1 } });
    expect(await count('installment_plans')).toBe(0);
  });
  it('rolls back purchases, claims and observations when final import completion fails', async () => {
    const p = await preview(); const before = await fixture.snapshot(); const transaction = fixture.pool.transaction.bind(fixture.pool);
    vi.spyOn(fixture.pool, 'transaction').mockImplementation(fn => transaction(client => fn({ query: async (sql, values) => {
      if (sql.startsWith('INSERT INTO olbia.bank_imports') && values?.[3] === 'applied') throw new Error('Completion fault');
      return client.query(sql, values);
    } })));
    await expect(apply(p.importId)).rejects.toThrow('Completion fault');
    expect(await fixture.snapshot()).toEqual(before);
    expect((await imports.readBankImport('amex_activity', p.importId, owner))?.status).toBe('previewed');
  });
  it.runIf(Boolean(process.env.AMEX_ACTIVITY_FIXTURE_PATH))('applies an external original and retries without versioning its contents', async () => {
    const p = await previewBytes(readFileSync(process.env.AMEX_ACTIVITY_FIXTURE_PATH!));
    expect(p.rows.length).toBeGreaterThan(0);
    const decisions = Object.fromEntries(p.rows.filter(r => r.kind === 'msi').map(row => [row.identity,
      row.installmentMonths ? { action: 'create_plan', months: row.installmentMonths, cuotaMinor: row.amountMinor } : { action: 'skip' }]));
    const expected = p.rows.filter(r => r.status === 'new' || r.kind === 'msi' && r.installmentMonths).length;
    expect(await apply(p.importId, decisions)).toMatchObject({ summary: { created: expected } });
    expect(await count()).toBe(expected);
    const before = await fixture.snapshot();
    expect(await apply(p.importId, decisions)).toMatchObject({ alreadyApplied: true });
    expect(await fixture.snapshot()).toEqual(before);
  });
});

it.each(['xlsx-preview-first','pdf-first'])('%s keeps a confirmed manual purchase through later Excel months and overlap',async order=>{
  const ledger=await import('@finance/ledger/native-ledger');
  const id=randomUUID(),observation=randomUUID(),at='2026-09-30T12:00:00.000Z';
  const plan=buildMsiSchedule({principalMinor:8940,cuotaMinor:2980,months:3,startMonth:'2026-10',origin:'manual'});
  const source={bucket:'evidence',key:'manual.json',sha256:'d'.repeat(64),contentType:'application/json'};
  await fixture.run(async()=>{
    await ledger.insertLedgerMovement(currentSqlClient()!,{id,institution:'american_express_mx',eventType:'card_purchase',status:'accepted',
      amount:{amountMinor:8940,currency:'MXN'},merchantRaw:'Mi compra manual',occurredAt:at,receivedAt:at,ingestedAt:at,
      source,parserVersion:'manual-entry-v1',parseWarnings:[],msi:plan,tags:['compra:reloj']},observation,at);
    await ledger.appendLedgerObservation(currentSqlClient()!,{id:observation,movementId:id,captureSource:'manual',
      institution:'american_express_mx',eventType:'card_purchase',amount:{amountMinor:8940,currency:'MXN'},merchantRaw:'Mi compra manual',
      observedAt:at,reconciliationAt:at,occurredAt:at,source,parserVersion:'manual-entry-v1',parseWarnings:[]});
  });
  const rows=[{date:'04 Nov 2026',purchaseDate:'05 Nov 2026',amount:30,merchant:'BANK MERCHANT',reference:'AT-quota-two',detail:'CARGO 02 DE 03 /REFpurchase-one'}];
  if(order==='xlsx-preview-first'){
    const first=await preview(rows);
    expect(first.rows[0]).toMatchObject({status:'needs_decision',reason:'conflicting_msi_plan',candidateEventIds:[id]});
    const before=await fixture.snapshot();
    await expect(apply(first.importId,{[first.rows[0].identity]:{action:'create_plan',months:3,cuotaMinor:3000}})).rejects.toThrow('cambiaron');
    expect(await fixture.snapshot()).toEqual(before);
  }
  const document:AmexStatementDocument={accountLastFour:'3456',product:'Gold Elite American Express',period:{from:'2026-09-07',to:'2026-10-06'},
    charges:[{identity:'bank-quota-one',merchantRaw:'BANK MERCHANT',occurredOn:'2026-10-04',amountMinor:3000,credit:false,msi:true,
      installmentIndex:1,installmentMonths:3,merchantReference:'purchase-one'}],
    msiPlans:[{merchantRaw:'BANK MERCHANT',originalOn:'2026-09-30',originalAmountMinor:9000,pendingMinor:6000,cuotaMinor:3000,installmentIndex:1,installmentMonths:3}],deferralCredits:[]};
  const pdf=await previewPdf(document),candidate=pdf.rows[0].candidates.find(c=>c.id===id)!;
  expect(candidate.canReconcilePlan).toBe(true);
  expect(await applyPdf(pdf.importId,document,{[pdf.rows[0].identity]:{action:'reconcile_plan',eventId:id,expectedPlan:candidate.expectedPlan}}))
    .toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
  const weekly=await preview(rows);
  expect(weekly.rows[0]).toMatchObject({status:'matched',eventId:id});
  expect(await apply(weekly.importId)).toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
  const monthly=await previewBytes(activityWorkbook([{date:'04 Dic 2026',amount:30,merchant:'BANK MERCHANT',
    reference:'AT-quota-three',detail:'CARGO 03 DE 03 /REFpurchase-one'}],'23456','07 Nov 2026 a 06 Dic 2026'));
  expect(monthly.rows[0]).toMatchObject({status:'matched',eventId:id});
  expect(await apply(monthly.importId)).toMatchObject({summary:{created:0,linked:1,msiConfirmed:1}});
  const overlap=await preview([{date:'04 Nov 2026',amount:-1,reference:'AT-payment'},...rows]);
  expect(overlap.rows.map(row=>row.status)).toEqual(['excluded','duplicate']);
  expect(await apply(overlap.importId)).toMatchObject({summary:{created:0,linked:0,skipped:2}});
  const beforeReplay=await fixture.snapshot();expect(await apply(weekly.importId)).toMatchObject({alreadyApplied:true});
  expect(await fixture.snapshot()).toEqual(beforeReplay);
  expect((await fixture.sql.query('SELECT movement_id FROM olbia.installment_plans')).rows).toEqual([{movement_id:id}]);
  expect((await fixture.sql.query('SELECT merchant_raw,amount_minor,account_last_four FROM olbia.ledger_movements')).rows)
    .toEqual([{merchant_raw:'Mi compra manual',amount_minor:9000,account_last_four:'3456'}]);
  expect((await fixture.sql.query('SELECT status,evidence_import_kind FROM olbia.installment_entries ORDER BY installment_index')).rows)
    .toEqual([{status:'spent',evidence_import_kind:'amex_statement'},{status:'spent',evidence_import_kind:'amex_activity'},{status:'spent',evidence_import_kind:'amex_activity'}]);
  expect((await fixture.sql.query('SELECT tag FROM olbia.ledger_tags')).rows).toEqual([{tag:'compra:reloj'}]);
  expect((await fixture.sql.query('SELECT amount_minor FROM olbia.ledger_observations WHERE id=$1',[observation])).rows)
    .toEqual([{amount_minor:8940}]);
});

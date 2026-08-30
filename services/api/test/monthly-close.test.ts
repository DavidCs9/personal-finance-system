import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategorizedSpendEvent, WealthSnapshot } from '@finance/domain';
import type { WealthBalanceOverview } from '../src/wealth/service.js';

process.env.METADATA_TABLE_NAME ??= 'test-metadata';
process.env.RAW_EMAIL_BUCKET_NAME ??= 'test-raw-email';
process.env.MONTHLY_CLOSE_OWNER ??= 'owner-1';
process.env.WEB_APP_URL ??= 'https://finance.example.test';

const {
  buildMonthlyCloseFacts,
} = await import('../src/reports/monthly-close.js');
const {
  analyzeMonthlyClose,
  clearMonthlyCloseProfileCache,
  extractMonthlyCloseProfile,
  fallbackMonthlyCloseAnalysis,
  parseMonthlyCloseAnalysis,
  resolveMonthlyCloseProfile,
} = await import('../src/reports/monthly-close-analysis.js');
const { renderMonthlyCloseEmail } = await import('../src/reports/monthly-close-email.js');
const { runMonthlyClose } = await import('../src/reports/monthly-close-handler.js');

const event = (
  id: string,
  amountMinor: number,
  occurredAt: string,
  overrides: Partial<CategorizedSpendEvent> = {},
): CategorizedSpendEvent => ({
  id,
  amountMinor,
  status: 'accepted',
  occurredAt,
  receivedAt: occurredAt,
  merchantRaw: id,
  categoryId: 'restaurantes',
  tags: [],
  ...overrides,
});

const snapshot = (
  accountId: WealthSnapshot['accountId'],
  day: string,
  amountMinor: number,
): WealthSnapshot => ({
  accountId,
  day,
  capturedAt: `${day}T12:00:00.000Z`,
  source: accountId === 'fondo_ahorro' ? 'derived' : accountId === 'ibkr' ? 'flex' : accountId === 'bitso' ? 'api' : 'manual',
  currency: 'MXN',
  totalMxnMinor: amountMinor,
  holdings: [],
});

const wealth = (day: string, amounts: {
  readonly ibkr: number;
  readonly cajita: number;
  readonly debt: number;
}): WealthBalanceOverview => ({
  currency: 'MXN',
  asOfDay: day,
  totalMxnMinor: amounts.ibkr + amounts.cajita,
  assetsMxnMinor: amounts.ibkr + amounts.cajita,
  liabilitiesMxnMinor: amounts.debt,
  netMxnMinor: amounts.ibkr + amounts.cajita - amounts.debt,
  accounts: [
    {
      id: 'ibkr', name: 'IBKR <Main>', institution: 'IBKR', role: 'brokerage', sync: 'flex', connected: true,
      latestSnapshot: snapshot('ibkr', day, amounts.ibkr),
    },
    {
      id: 'nu_cajita_emergencia', name: 'Cajita Nu', institution: 'Nu', role: 'emergency_fund', sync: 'manual', connected: true,
      latestSnapshot: snapshot('nu_cajita_emergencia', day.slice(0, 8) + '20', amounts.cajita),
    },
    {
      id: 'fondo_ahorro', name: 'Fondo de ahorro', institution: 'Nómina', role: 'payroll_savings', sync: 'derived', connected: false,
      latestSnapshot: null,
    },
    {
      id: 'bitso', name: 'Bitso', institution: 'Bitso', role: 'crypto', sync: 'api', connected: false,
      latestSnapshot: null,
    },
  ],
  liabilities: [{
    cardId: 'amex',
    name: 'Amex',
    latestSnapshot: {
      cardId: 'amex', day, capturedAt: `${day}T12:00:00.000Z`, source: 'manual', currency: 'MXN', totalMxnMinor: amounts.debt,
    },
  }],
});

const currentEvents: readonly CategorizedSpendEvent[] = [
  event('Contramar', 10_000_00, '2026-09-10T18:00:00Z', {
    personalAmountMinor: 4_000_00,
    tags: ['viaje:cdmx'],
  }),
  event('Pendiente', 3_000_00, '2026-09-11T18:00:00Z', {
    categoryId: null,
    status: 'needs_review',
  }),
  event('Compra MSI', 12_000_00, '2026-07-01T18:00:00Z', {
    tags: ['viaje:cdmx', 'compartido'],
    msi: {
      months: 6,
      principalMinor: 12_000_00,
      cuotaMinor: 2_000_00,
      installments: [{ index: 3, month: '2026-09', amountMinor: 2_000_00, status: 'spent' }],
    },
  }),
  event('Agosto', 2_000_00, '2026-08-10T18:00:00Z'),
  event('Julio', 1_000_00, '2026-07-10T18:00:00Z'),
  event('Junio', 3_000_00, '2026-06-10T18:00:00Z'),
];

const buildFacts = () => buildMonthlyCloseFacts('owner-1', '2026-09', new Date('2026-10-01T13:10:00.000Z'), {
  loadEvents: vi.fn().mockResolvedValue(currentEvents),
  loadCategories: vi.fn().mockResolvedValue([{ id: 'restaurantes', name: 'Restaurantes', sortOrder: 10 }]),
  loadWealthAsOf: vi.fn().mockImplementation(async (_owner: string, day: string) => day === '2026-09-30'
    ? wealth(day, { ibkr: 80_000_00, cajita: 20_000_00, debt: 10_000_00 })
    : wealth(day, { ibkr: 60_000_00, cajita: 20_000_00, debt: 8_000_00 })),
});

describe('monthly close facts', () => {
  it('keeps Has gastado semantics, overlapping tags, historical wealth, and deterministic signals', async () => {
    const facts = await buildFacts();

    expect(facts.month).toBe('2026-09');
    expect(facts.closeDay).toBe('2026-09-30');
    expect(facts.spending.totalSpentMinor).toBe(9_000_00);
    expect(facts.spending.uncategorizedMinor).toBe(3_000_00);
    expect(facts.spending.uncertainMinor).toBe(3_000_00);
    expect(facts.spending.categories.find((category) => category.key === 'restaurantes')).toMatchObject({
      amountMinor: 6_000_00,
      againstAmountMinor: 2_000_00,
      deltaMinor: 4_000_00,
      priorThreeMonthAverageMinor: 2_000_00,
      topMerchants: [
        expect.objectContaining({ label: 'Contramar', amountMinor: 4_000_00 }),
        expect.objectContaining({ label: 'Compra MSI', amountMinor: 2_000_00 }),
      ],
    });
    expect(facts.spending.tags.find((tag) => tag.key === 'viaje:cdmx')).toMatchObject({
      amountMinor: 6_000_00,
      eventCount: 2,
    });
    expect(facts.wealth).toMatchObject({
      comparable: true,
      netMxnMinor: 90_000_00,
      priorNetMxnMinor: 72_000_00,
      netDeltaMinor: 18_000_00,
    });
    expect(facts.signals.map((signal) => signal.id)).toEqual(expect.arrayContaining([
      'spending:uncertain',
      'spending:uncategorized',
      'category:restaurantes',
      'wealth:concentration:ibkr',
      'wealth:liability-increase',
      'stale:nu_cajita_emergencia',
    ]));
  });
});

describe('monthly close AI analysis', () => {
  it('accepts grounded prose and rejects generated figures or unknown signals', async () => {
    const facts = await buildFacts();
    const valid = {
      headline: 'Tu patrimonio avanzó, pero el gasto dejó señales para revisar.',
      executiveSummary: 'El cierre separa lo que gastaste del estado de tus activos y deudas.',
      spendingNarrative: 'Restaurantes explicó la mayor presión y el viaje cruzó varios contextos.',
      wealthNarrative: 'IBKR concentró el cambio observado y las tarjetas redujeron parte del avance.',
      selectedSignalIds: ['spending:uncertain'],
    };
    expect(parseMonthlyCloseAnalysis(valid, facts.signals.map((signal) => signal.id))).toEqual(valid);
    expect(() => parseMonthlyCloseAnalysis({ ...valid, headline: 'Subió 20%' }, facts.signals.map((signal) => signal.id)))
      .toThrow(/must not contain generated figures/);
    expect(() => parseMonthlyCloseAnalysis({ ...valid, selectedSignalIds: ['invented'] }, facts.signals.map((signal) => signal.id)))
      .toThrow(/unknown signal/);
  });

  it('uses structured output with an explicit token ceiling', async () => {
    const facts = await buildFacts();
    const client = { send: vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      output: { message: { role: 'assistant', content: [{ text: JSON.stringify({
        headline: 'Tu cierre avanzó con señales que requieren atención.',
        executiveSummary: 'El gasto y el patrimonio muestran movimientos distintos durante el periodo.',
        spendingNarrative: 'Restaurantes encabezó el cambio y el viaje atravesó más de una categoría.',
        wealthNarrative: 'IBKR concentró el valor observado y la deuda moderó parte del avance.',
        selectedSignalIds: ['category:restaurantes'],
      }) }] } },
    }) };

    const sourcePrompt = `Eres Olbia.\n\n## Perfil personal de David\nDavid construye patrimonio para conservar margen de elección y experiencias valiosas.\n\n## Voz\nDirecta, firme y natural.\n\n## Reglas operativas\nNo uses shell.`;
    const personalProfile = extractMonthlyCloseProfile(sourcePrompt);
    await analyzeMonthlyClose(facts, client, 'test-model', async () => personalProfile);

    const command = client.send.mock.calls[0]?.[0];
    expect(command.input).toMatchObject({
      modelId: 'test-model',
      inferenceConfig: { maxTokens: 1_200 },
      outputConfig: { textFormat: { type: 'json_schema' } },
    });
    const system = command.input.system?.[0]?.text;
    expect(system).toContain('David construye patrimonio para conservar margen de elección');
    expect(system).toContain('No eres un boletín financiero ni un asesor intercambiable');
    expect(system).toContain('Una experiencia valiosa no es automáticamente un error');
    expect(system).not.toContain('No uses shell');
  });

  it('rejects a profile prompt without the private profile and voice sections', () => {
    expect(() => extractMonthlyCloseProfile('Eres un asistente genérico.')).toThrow(/missing profile or voice/);
  });

  it('resolves the active immutable profile through the shared SSM pointer', async () => {
    clearMonthlyCloseProfileCache();
    const parameterClient = { send: vi.fn().mockResolvedValue({
      Parameter: { Value: 'arn:aws:bedrock:us-east-2:123456789012:prompt/ABCDEFGHIJ:10' },
    }) };
    const promptClient = { send: vi.fn().mockResolvedValue({
      defaultVariant: 'default',
      variants: [{
        name: 'default',
        templateConfiguration: { text: { text: `## Perfil personal\nPrioridades privadas.\n\n## Voz\nDirecta.\n\n## Reglas operativas\nTools.` } },
      }],
    }) };

    await expect(resolveMonthlyCloseProfile(promptClient, parameterClient, '/prompt-pointer'))
      .resolves.toContain('Prioridades privadas.');
    expect(parameterClient.send.mock.calls[0]?.[0].input).toEqual({ Name: '/prompt-pointer' });
    expect(promptClient.send.mock.calls[0]?.[0].input).toEqual({
      promptIdentifier: 'arn:aws:bedrock:us-east-2:123456789012:prompt/ABCDEFGHIJ:10',
    });
  });
});

describe('monthly close email rendering', () => {
  it('renders a responsive HTML and text close while escaping user-visible labels', async () => {
    const facts = await buildFacts();
    const analysis = fallbackMonthlyCloseAnalysis(facts);
    const email = renderMonthlyCloseEmail(facts, analysis, 'https://finance.example.test');

    expect(email.subject).toBe('Tu cierre de Septiembre · lectura de Olbia');
    expect(email.html).toContain('<!doctype html>');
    expect(email.html).toContain('Dónde se fue');
    expect(email.html).toContain('Los tags pueden cruzar varias categorías');
    expect(email.html).toContain('IBKR &lt;Main&gt;');
    expect(email.html).not.toContain('IBKR <Main>');
    expect(email.text).toContain('Los tags pueden superponerse; sus importes no se suman entre sí.');
    expect(email.text).toContain('NETO: $90,000');
    expect(Buffer.byteLength(email.html, 'utf8')).toBeLessThan(150_000);
  });
});

describe('monthly close orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back from AI, persists the prepared report, sends it, and marks it sent', async () => {
    const facts = await buildFacts();
    const prepared = vi.fn();
    const markSent = vi.fn();
    const send = vi.fn().mockResolvedValue('ses-message-1');

    const result = await runMonthlyClose(new Date('2026-10-01T13:10:00.000Z'), {
      getRecord: vi.fn().mockResolvedValue(undefined),
      prepare: prepared,
      markSent,
      buildFacts: vi.fn().mockResolvedValue(facts),
      analyze: vi.fn().mockRejectedValue(Object.assign(new Error('throttled'), { name: 'ThrottlingException' })),
      send,
    });

    expect(result).toEqual({ month: '2026-09', status: 'sent', messageId: 'ses-message-1', analysisSource: 'fallback' });
    expect(prepared).toHaveBeenCalledWith('owner-1', '2026-09', expect.objectContaining({
      analysisSource: 'fallback',
      analysisErrorName: 'ThrottlingException',
      email: expect.objectContaining({ subject: 'Tu cierre de Septiembre · lectura de Olbia' }),
    }), expect.any(Date));
    expect(send).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalledWith('owner-1', '2026-09', 'ses-message-1', expect.any(Date));
  });

  it('does not rebuild or resend a report already marked sent', async () => {
    const build = vi.fn();
    const send = vi.fn();
    const result = await runMonthlyClose(new Date('2026-10-01T13:10:00.000Z'), {
      getRecord: vi.fn().mockResolvedValue({ status: 'sent' }),
      prepare: vi.fn(),
      markSent: vi.fn(),
      buildFacts: build,
      analyze: vi.fn(),
      send,
    });

    expect(result).toEqual({ month: '2026-09', status: 'already_sent' });
    expect(build).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('closes December when the schedule runs on January first', async () => {
    const result = await runMonthlyClose(new Date('2027-01-01T13:10:00.000Z'), {
      getRecord: vi.fn().mockResolvedValue({ status: 'sent' }),
      prepare: vi.fn(),
      markSent: vi.fn(),
      buildFacts: vi.fn(),
      analyze: vi.fn(),
      send: vi.fn(),
    });

    expect(result).toEqual({ month: '2026-12', status: 'already_sent' });
  });
});

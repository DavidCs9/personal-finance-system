import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { MonthlyCloseFacts } from './monthly-close.js';

export const MONTHLY_CLOSE_ANALYSIS_VERSION = 'monthly-close-analysis-v1';

export interface MonthlyCloseAnalysis {
  readonly headline: string;
  readonly executiveSummary: string;
  readonly spendingNarrative: string;
  readonly wealthNarrative: string;
  readonly selectedSignalIds: readonly string[];
}

export interface MonthlyCloseBedrockClient {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
  maxAttempts: 5,
  retryMode: 'adaptive',
});

const systemPrompt = `Eres la voz analítica de Olbia, un sistema personal de finanzas en México.
Recibes un paquete cerrado de hechos calculados por código. No recalcules importes, no inventes causalidad y no uses conocimiento externo.
Escribe en español de México con voz precisa, firme, útil y cercana. No felicites, no regañes y no uses lenguaje de bienestar.
Las categorías son aditivas; los tags son lentes superpuestos y nunca deben sumarse entre sí.
Los cambios en inversiones son cambios de valor observado, no rendimientos ajustados por aportaciones o retiros.
No incluyas dígitos, signos de moneda ni porcentajes en ningún texto: la plantilla insertará todas las cifras verificadas.
Selecciona únicamente signal IDs presentes en el paquete. Devuelve JSON conforme al schema.`;

const analysisSchema = (facts: MonthlyCloseFacts) => {
  const ids = facts.signals.map((signal) => signal.id);
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: { type: 'string', minLength: 1, maxLength: 120 },
      executiveSummary: { type: 'string', minLength: 1, maxLength: 520 },
      spendingNarrative: { type: 'string', minLength: 1, maxLength: 420 },
      wealthNarrative: { type: 'string', minLength: 1, maxLength: 420 },
      selectedSignalIds: {
        type: 'array',
        minItems: 0,
        maxItems: Math.min(3, ids.length),
        uniqueItems: true,
        items: ids.length > 0 ? { type: 'string', enum: ids } : { type: 'string' },
      },
    },
    required: ['headline', 'executiveSummary', 'spendingNarrative', 'wealthNarrative', 'selectedSignalIds'],
  } as const;
};

const responseText = (response: ConverseCommandOutput): string => {
  if (response.stopReason === 'max_tokens') throw new Error('Monthly close analysis reached maxTokens.');
  const output = response.output;
  if (!output || !('message' in output)) throw new Error('Monthly close analysis returned no message.');
  const text = output.message?.content?.find((block) => 'text' in block)?.text;
  if (!text) throw new Error('Monthly close analysis returned no text.');
  return text;
};

const recordValue = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Monthly close analysis response must be an object.');
  }
  return value as Record<string, unknown>;
};

const proseValue = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string') throw new Error(`Monthly close ${field} must be text.`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`Monthly close ${field} has invalid length.`);
  if (/[\d$%]/u.test(normalized)) throw new Error(`Monthly close ${field} must not contain generated figures.`);
  return normalized;
};

export const parseMonthlyCloseAnalysis = (
  value: string | unknown,
  allowedSignalIds: readonly string[],
): MonthlyCloseAnalysis => {
  const record = recordValue(typeof value === 'string' ? JSON.parse(value) : value);
  if (!Array.isArray(record.selectedSignalIds)) throw new Error('Monthly close selectedSignalIds must be an array.');
  const allowed = new Set(allowedSignalIds);
  const selectedSignalIds = record.selectedSignalIds.map((id) => {
    if (typeof id !== 'string' || !allowed.has(id)) throw new Error('Monthly close analysis selected an unknown signal.');
    return id;
  });
  if (new Set(selectedSignalIds).size !== selectedSignalIds.length || selectedSignalIds.length > 3) {
    throw new Error('Monthly close analysis selected duplicate or excessive signals.');
  }
  return {
    headline: proseValue(record.headline, 'headline', 120),
    executiveSummary: proseValue(record.executiveSummary, 'executiveSummary', 520),
    spendingNarrative: proseValue(record.spendingNarrative, 'spendingNarrative', 420),
    wealthNarrative: proseValue(record.wealthNarrative, 'wealthNarrative', 420),
    selectedSignalIds,
  };
};

export const fallbackMonthlyCloseAnalysis = (facts: MonthlyCloseFacts): MonthlyCloseAnalysis => ({
  headline: facts.wealth.netDeltaMinor !== null && facts.wealth.netDeltaMinor < 0
    ? 'Tu patrimonio retrocedió y el gasto dejó señales que conviene revisar.'
    : 'Tu cierre muestra el estado del mes y puntos concretos para revisar.',
  executiveSummary: 'Olbia separó el gasto del mes del estado de tu patrimonio. Revisa las señales con mayor impacto y confirma cualquier saldo pendiente antes de usar este cierre como referencia.',
  spendingNarrative: facts.spending.deltaMinor > 0
    ? 'El gasto terminó por encima del mes anterior. Las categorías y contextos principales muestran dónde se concentró el cambio.'
    : 'El gasto no superó el mes anterior. Las categorías y contextos principales muestran cómo se distribuyó el cierre.',
  wealthNarrative: facts.wealth.comparable
    ? 'El patrimonio usa el último saldo conocido de cada cuenta al cierre. Los cambios de inversión describen valor observado y no rendimiento ajustado.'
    : 'Este es el primer cierre patrimonial comparable de Olbia. Cada cuenta usa el último saldo conocido disponible al final del mes.',
  selectedSignalIds: facts.signals.slice(0, 3).map((signal) => signal.id),
});

export const analyzeMonthlyClose = async (
  facts: MonthlyCloseFacts,
  client: MonthlyCloseBedrockClient = bedrock,
  modelId = process.env.MONTHLY_CLOSE_MODEL_ID,
): Promise<MonthlyCloseAnalysis> => {
  if (!modelId) throw new Error('MONTHLY_CLOSE_MODEL_ID is required.');
  const response = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: JSON.stringify(facts) }] }],
    inferenceConfig: { maxTokens: 1_200 },
    outputConfig: {
      textFormat: {
        type: 'json_schema',
        structure: { jsonSchema: {
          name: 'olbia_monthly_close_analysis',
          description: 'Grounded narrative and ranked signals for one Olbia monthly close.',
          schema: JSON.stringify(analysisSchema(facts)),
        } },
      },
    },
    requestMetadata: {
      feature: 'monthly-close-email',
      reportMonth: facts.month,
      analysisVersion: MONTHLY_CLOSE_ANALYSIS_VERSION,
    },
  }));
  return parseMonthlyCloseAnalysis(responseText(response), facts.signals.map((signal) => signal.id));
};

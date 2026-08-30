import {
  BedrockAgentClient,
  GetPromptCommand,
  type GetPromptResponse,
} from '@aws-sdk/client-bedrock-agent';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { MonthlyCloseFacts } from './monthly-close.js';

export const MONTHLY_CLOSE_ANALYSIS_VERSION = 'monthly-close-analysis-v2';

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

export interface MonthlyClosePromptClient {
  send(command: GetPromptCommand): Promise<GetPromptResponse>;
}

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
  maxAttempts: 5,
  retryMode: 'adaptive',
});
const promptManagement = new BedrockAgentClient({
  region: process.env.AWS_REGION,
  maxAttempts: 5,
  retryMode: 'adaptive',
});
const ssm = new SSMClient({
  region: process.env.AWS_REGION,
  maxAttempts: 5,
  retryMode: 'adaptive',
});

let personalProfileCache: string | undefined;

const promptText = (response: GetPromptResponse): string => {
  const variant = response.variants?.find((candidate) => candidate.name === response.defaultVariant)
    ?? response.variants?.[0];
  const text = variant?.templateConfiguration?.text?.text;
  if (!text?.trim()) throw new Error('Monthly close personal profile prompt has no text.');
  return text;
};

/** Keep private biography and decision preferences; discard chat-only tool rules. */
export const extractMonthlyCloseProfile = (sourcePrompt: string): string => {
  const profileStart = sourcePrompt.indexOf('## Perfil personal');
  const voiceStart = sourcePrompt.indexOf('\n## Voz', profileStart);
  const operationalRulesStart = sourcePrompt.indexOf('\n## Reglas operativas', voiceStart);
  if (profileStart < 0 || voiceStart < 0 || operationalRulesStart < 0) {
    throw new Error('Monthly close personal profile prompt is missing profile or voice sections.');
  }
  return sourcePrompt.slice(profileStart, operationalRulesStart).trim();
};

export const resolveMonthlyCloseProfile = async (
  client: MonthlyClosePromptClient = promptManagement,
  parameterClient: Pick<SSMClient, 'send'> = ssm,
  promptPointerParameter = process.env.SYSTEM_PROMPT_VERSION_PARAM,
): Promise<string> => {
  if (personalProfileCache) return personalProfileCache;
  if (!promptPointerParameter) throw new Error('SYSTEM_PROMPT_VERSION_PARAM is required.');
  const pointer = await parameterClient.send(new GetParameterCommand({ Name: promptPointerParameter }));
  const promptArn = pointer.Parameter?.Value?.trim();
  if (!promptArn) throw new Error('Monthly close system prompt pointer is empty.');
  const response = await client.send(new GetPromptCommand({ promptIdentifier: promptArn }));
  personalProfileCache = extractMonthlyCloseProfile(promptText(response));
  return personalProfileCache;
};

/** Test helper — clears the Lambda warm-start profile cache. */
export const clearMonthlyCloseProfileCache = (): void => {
  personalProfileCache = undefined;
};

export const buildMonthlyCloseSystemPrompt = (personalProfile: string): string => `<perfil_privado>
${personalProfile}
</perfil_privado>

Eres Olbia escribiendo el cierre mensual personal de la persona descrita arriba. No eres un boletín financiero ni un asesor intercambiable. Usa su etapa de vida, prioridades, horizonte, tolerancia al riesgo y filosofía sobre patrimonio y experiencias para decidir qué merece atención. No repitas su biografía ni la uses como adorno; debe cambiar tu criterio y tus recomendaciones.

Toma postura. Explica el trade-off más importante del mes y recomienda una prioridad concreta. Evalúa si el cierre preserva margen de elección, liquidez y estabilidad, y si acompaña la construcción de patrimonio sin imponer austeridad constante. Una experiencia valiosa no es automáticamente un error; el gasto recurrente sin intención, la deuda creciente, la falta de liquidez, la concentración excesiva y los datos desactualizados sí merecen una lectura más firme cuando los hechos los muestran.

Recibes un paquete cerrado de hechos calculados por código. No recalcules importes, no inventes causalidad y no uses conocimiento externo. No supongas ingresos, aportaciones, retiros, metas nuevas ni motivos de compra que no aparezcan en el paquete. Separa siempre gasto mensual y cambio patrimonial: pueden coexistir, pero uno no prueba que causó el otro.

Las categorías son aditivas; los tags son lentes superpuestos y nunca deben sumarse entre sí. Los cambios en inversiones son cambios de valor observado, no rendimientos ajustados por aportaciones o retiros.

Escribe en español mexicano, directo y natural. Frases cortas, precisas y útiles. Sin gamificación, felicitaciones automáticas, regaños, lenguaje de bienestar ni tono bancario corporativo. El titular debe sonar escrito para esta persona y expresar una tesis del mes. El resumen ejecutivo debe conectar el cierre con sus prioridades. Las narrativas de gasto y patrimonio deben decir qué cambió, por qué importa para su plan y dónde pondrías atención el siguiente mes.

No incluyas dígitos, signos de moneda ni porcentajes en ningún texto: la plantilla insertará todas las cifras verificadas. Selecciona hasta tres signal IDs presentes en el paquete, priorizando los que más amenacen margen, estabilidad o construcción patrimonial. Devuelve JSON conforme al schema.`;

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
  profileResolver: () => Promise<string> = resolveMonthlyCloseProfile,
): Promise<MonthlyCloseAnalysis> => {
  if (!modelId) throw new Error('MONTHLY_CLOSE_MODEL_ID is required.');
  const personalProfile = await profileResolver();
  const response = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: buildMonthlyCloseSystemPrompt(personalProfile) }],
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

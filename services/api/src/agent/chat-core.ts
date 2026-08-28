import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessBedrockModelConfig,
} from '@aws-sdk/client-bedrock-agentcore';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { resolveRuntimePrompt } from './prompt-runtime.js';

const harnessArn = process.env.HARNESS_ARN?.trim();
const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID?.trim();
const cognitoClientId = process.env.COGNITO_CLIENT_ID?.trim();
const agentcore = new BedrockAgentCoreClient({
  region: process.env.AGENTCORE_REGION?.trim() || undefined,
});

const jwtVerifier = cognitoUserPoolId && cognitoClientId
  ? CognitoJwtVerifier.create({
    userPoolId: cognitoUserPoolId,
    tokenUse: 'id',
    clientId: cognitoClientId,
  })
  : undefined;

export type AgentSseEvent =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'reasoning_start'; readonly reasoningId: string; readonly label: string }
  | { readonly type: 'reasoning_complete'; readonly reasoningId: string; readonly durationMs: number }
  | { readonly type: 'tool_start'; readonly toolUseId: string; readonly name: string; readonly label: string; readonly attempt: number }
  | { readonly type: 'tool_complete'; readonly toolUseId: string; readonly name: string; readonly label: string; readonly attempt: number; readonly durationMs: number; readonly summary?: string; readonly material: boolean }
  | { readonly type: 'tool_failed'; readonly toolUseId: string; readonly name: string; readonly label: string; readonly attempt: number; readonly durationMs: number; readonly message: string }
  | { readonly type: 'citation'; readonly kind: string; readonly id?: string; readonly label: string }
  | { readonly type: 'proposal'; readonly kind: 'recategorize'; readonly eventId: string; readonly categoryId: string; readonly message: string }
  | { readonly type: 'mutation'; readonly kind: 'tag_edit'; readonly action: 'applied' | 'undone'; readonly operationId: string; readonly movementCount: number; readonly amountMinor: number; readonly fromDay: string; readonly toDay: string; readonly change: Record<string, unknown> }
  | { readonly type: 'done'; readonly requestId: string; readonly sessionId: string }
  | { readonly type: 'error'; readonly message: string; readonly requestId: string };

/** Fields shared by API Gateway HTTP API v2 and REST API v1 proxy events. */
export type AgentChatGatewayEvent = {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly headers?: Record<string, string | undefined>;
  readonly httpMethod?: string;
  readonly requestContext: {
    readonly requestId?: string;
    readonly http?: { readonly method?: string };
    readonly authorizer?: {
      readonly jwt?: { readonly claims?: { readonly sub?: string } };
      readonly claims?: { readonly sub?: string };
    };
  };
};

export const formatSse = (event: AgentSseEvent): string => `data: ${JSON.stringify(event)}\n\n`;

export const headerValue = (
  headers: AgentChatGatewayEvent['headers'],
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
};

export const readBody = (event: AgentChatGatewayEvent): string | undefined => {
  if (!event.body) return undefined;
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
};

export const parseChatBody = (raw: string | undefined): {
  message: string;
  month: string;
  sessionId: string;
} => {
  let parsed: Record<string, unknown> = {};
  if (raw?.trim()) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('Body JSON inválido.');
    }
  }
  const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  const month = typeof parsed.month === 'string' ? parsed.month : '';
  if (!message) throw new Error('message es obligatorio.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('month debe ser YYYY-MM.');
  const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.length >= 33
    ? parsed.sessionId
    : randomUUID();
  return { message, month, sessionId };
};

/** Prefer the API Gateway authorizer; Function URL callers retain Bearer verification for rollback only. */
export const resolveOwner = async (event: AgentChatGatewayEvent): Promise<string> => {
  const authorizerSub = event.requestContext.authorizer?.jwt?.claims?.sub
    ?? event.requestContext.authorizer?.claims?.sub;
  if (authorizerSub) return authorizerSub;

  if (!jwtVerifier) {
    throw new Error('Cognito JWT verifier is not configured.');
  }
  const authorization = headerValue(event.headers, 'authorization');
  if (!authorization?.toLowerCase().startsWith('bearer ')) {
    throw new Error('Missing authenticated principal.');
  }
  const token = authorization.slice(7).trim();
  const claims = await jwtVerifier.verify(token);
  if (!claims.sub) throw new Error('Missing authenticated principal.');
  return claims.sub;
};

export class AgentOwnerForbiddenError extends Error {}

export const assertConfiguredAgentOwner = (owner: string): void => {
  const configuredOwner = process.env.AGENT_OWNER?.trim();
  if (!configuredOwner) throw new Error('AGENT_OWNER is not configured on the agent proxy.');
  if (owner !== configuredOwner) {
    throw new AgentOwnerForbiddenError('Este usuario no está autorizado para usar el asistente financiero.');
  }
};

export const agentChatErrorStatus = (error: unknown): number => {
  if (error instanceof AgentOwnerForbiddenError) return 403;
  const message = error instanceof Error ? error.message : String(error);
  return /principal|Bearer|JWT|Unauthorized|token/i.test(message) ? 401 : 400;
};

export const requestMethod = (event: AgentChatGatewayEvent): string =>
  (event.requestContext.http?.method ?? event.httpMethod ?? '').toUpperCase();

export const requestIdOf = (event: AgentChatGatewayEvent): string =>
  event.requestContext.requestId || randomUUID();

const isTransient = (error: unknown): boolean => {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name: string }).name)
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return /throttl|timeout|temporar|429|503|ECONNRESET/i.test(`${name} ${message}`);
};

const citationsFromPayload = (data: Record<string, unknown>): AgentSseEvent[] => {
  const out: AgentSseEvent[] = [];
  if (Array.isArray(data.movements)) {
    for (const row of (data.movements as { id?: string; merchantRaw?: string }[]).slice(0, 8)) {
      if (row.merchantRaw) {
        out.push({ type: 'citation', kind: 'movement', id: row.id, label: row.merchantRaw });
      }
    }
  }
  if (data.month && data.summary) {
    out.push({ type: 'citation', kind: 'summary', label: `Resumen ${String(data.month)}` });
  }
  if (data.netMxnMinor !== undefined) {
    out.push({ type: 'citation', kind: 'wealth', label: 'Patrimonio' });
  }
  return out;
};

export const toolNameFromHarness = (name: string): string =>
  name.includes('___') ? name.split('___').slice(1).join('___') : name;

const toolLabel = (name: string): string => {
  switch (name) {
    case 'month_snapshot': return 'Revisando el resumen del mes';
    case 'plan_month_scenario': return 'Calculando escenarios del mes';
    case 'spend_by_category': return 'Revisando categorías de gasto';
    case 'spend_by_merchant': return 'Revisando comercios';
    case 'list_movements': return 'Revisando movimientos';
    case 'compare_months': return 'Comparando meses';
    case 'wealth_snapshot': return 'Revisando patrimonio';
    case 'investment_history': return 'Revisando historial de inversiones';
    case 'propose_recategorize': return 'Preparando una categoría';
    case 'preview_tag_edit': return 'Preparando los tags';
    case 'apply_tag_edit': return 'Aplicando los tags';
    case 'undo_tag_edit': return 'Restaurando los tags';
    default: return 'Consultando datos';
  }
};

const asArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

const normalizeIntent = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

export const requiresTravelPlanRecalculation = (message: string): boolean => {
  const normalized = normalizeIntent(message);
  return /\b(vegas|viaje|vuelo|hotel|itinerario|tramo|cdmx|tijuana)\b/.test(normalized)
    && /\b(gast|presupuest|plan|dia|fecha|regres|vuelo|tramo|primero|corr|del|hasta)\b/.test(normalized);
};

const travelTurnDirective = (message: string): string => {
  if (!requiresTravelPlanRecalculation(message)) return '';
  return [
    '',
    'Regla critica para este turno de planeacion de viaje:',
    '- Este turno continua una decision de presupuesto aunque el mensaje actual solo corrija una fecha, ciudad o tramo.',
    '- Antes de dar otra cifra, vuelve a usar plan_month_scenario con la correccion mas reciente y los datos ya confirmados en el hilo o memoria.',
    '- Nunca preguntes cuanto quiere gastar ni pidas un rango de gasto. La tool debe derivar el techo y los escenarios.',
    '- tripStart y tripEnd son el primer y ultimo dia calendario que el usuario esta fisicamente en el destino. tripEnd se incluye en calendarDays; nights es la diferencia entre fechas.',
    '- No deduzcas la salida de Las Vegas a partir de un vuelo que parte de otra ciudad. Si falta esa conexion, pregunta solo la fecha exacta de salida de Las Vegas hacia Tijuana; no preguntes por presupuesto.',
    '- Si una correccion cambia fechas, presupuesto, moneda o compromisos, invalida el calculo anterior y recalcula. No cuentes fechas mentalmente.',
  ].join('\n');
};

export const buildHarnessSystemPrompt = (basePrompt: string, message: string): string =>
  `${basePrompt}${travelTurnDirective(message)}`;

export const buildHarnessModelConfig = (prompt: {
  readonly modelId: string;
  readonly maxTokens: number;
  readonly temperature: number;
}): HarnessBedrockModelConfig => {
  if (/anthropic\.claude-sonnet-4-6(?:$|[-:])/.test(prompt.modelId)) {
    return {
      modelId: prompt.modelId,
      maxTokens: Math.max(prompt.maxTokens, 4_096),
      apiFormat: 'converse_stream',
      additionalParams: {
        additionalModelRequestFields: {
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
        },
      },
    };
  }
  return {
    modelId: prompt.modelId,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    apiFormat: 'converse_stream',
  };
};

/** A concise audit note; never include raw tool inputs or returned financial rows. */
export const summarizeToolResult = (
  name: string,
  payload: Record<string, unknown>,
): { readonly summary?: string; readonly material: boolean } => {
  switch (name) {
    case 'month_snapshot':
      return { summary: `Resumen de ${String(payload.month ?? 'este mes')} consultado.`, material: true };
    case 'plan_month_scenario':
      return { summary: `Plan de ${String(payload.month ?? 'este mes')} calculado.`, material: true };
    case 'spend_by_category': {
      const count = asArray(payload.buckets).length;
      return { summary: `Revisé ${count} categoría${count === 1 ? '' : 's'} de gasto.`, material: true };
    }
    case 'spend_by_merchant': {
      const count = asArray(payload.buckets).length;
      return { summary: `Revisé ${count} comercio${count === 1 ? '' : 's'}.`, material: true };
    }
    case 'list_movements': {
      const count = typeof payload.movementCount === 'number'
        ? payload.movementCount
        : asArray(payload.movements).length;
      const period = payload.fromDay && payload.toDay
        ? ` entre ${String(payload.fromDay)} y ${String(payload.toDay)}`
        : '';
      return {
        summary: `Revisé ${count} movimiento${count === 1 ? '' : 's'}${period}.`,
        material: true,
      };
    }
    case 'compare_months':
      return {
        summary: `Comparé ${String(payload.month ?? 'el mes')} con ${String(payload.againstMonth ?? 'el mes anterior')}.`,
        material: true,
      };
    case 'wealth_snapshot':
      return { summary: 'Patrimonio consultado.', material: true };
    case 'investment_history':
      return {
        summary: `Revisé el historial de ${String(payload.symbol ?? payload.accountId ?? 'la inversión')}.`,
        material: true,
      };
    case 'propose_recategorize':
      return { summary: 'Propuesta de categoría preparada.', material: false };
    case 'preview_tag_edit':
      return {
        summary: `Preparé ${Number(payload.movementCount ?? 0)} movimientos.`,
        material: false,
      };
    case 'apply_tag_edit':
      return {
        summary: `Actualicé ${Number(payload.movementCount ?? 0)} movimientos.`,
        material: true,
      };
    case 'undo_tag_edit':
      return {
        summary: `Restauré ${Number(payload.movementCount ?? 0)} movimientos.`,
        material: true,
      };
    default:
      return { material: false };
  }
};

const tryParseJsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore partial JSON while streaming
  }
  return undefined;
};

export const mutationFromToolResult = (
  toolName: string | undefined,
  payload: Record<string, unknown>,
): Extract<AgentSseEvent, { readonly type: 'mutation' }> | undefined => {
  if ((toolName !== 'apply_tag_edit' && toolName !== 'undo_tag_edit')
    || typeof payload.operationId !== 'string') return undefined;
  return {
    type: 'mutation',
    kind: 'tag_edit',
    action: toolName === 'apply_tag_edit' ? 'applied' : 'undone',
    operationId: payload.operationId,
    movementCount: Number(payload.movementCount ?? 0),
    amountMinor: Number(payload.amountMinor ?? 0),
    fromDay: String(payload.fromDay ?? ''),
    toDay: String(payload.toDay ?? ''),
    change: payload.change && typeof payload.change === 'object'
      ? payload.change as Record<string, unknown>
      : {},
  };
};

async function* invokeHarnessStream(
  owner: string,
  month: string,
  userMessage: string,
  sessionId: string,
): AsyncGenerator<AgentSseEvent> {
  if (!harnessArn) {
    throw new Error('HARNESS_ARN no configurado: el proxy solo habla con AgentCore Harness.');
  }

  const prompt = await resolveRuntimePrompt();

  const response = await agentcore.send(new InvokeHarnessCommand({
    harnessArn,
    runtimeSessionId: sessionId,
    runtimeUserId: owner,
    // The Cognito subject is the hard boundary for durable AgentCore memory.
    // It is never accepted from the browser request body.
    actorId: owner,
    systemPrompt: [{ text: buildHarnessSystemPrompt(prompt.text, userMessage) }],
    model: {
      bedrockModelConfig: buildHarnessModelConfig(prompt),
    },
    messages: [{
      role: 'user',
      content: [{
        text: `Contexto: mes activo del selector = ${month}. Si la pregunta nombra otro mes, ese gana.\n\nPregunta: ${userMessage}`,
      }],
    }],
  }));

  const toolUseByIndex = new Map<number, { toolUseId: string; name: string; inputJson: string }>();
  const toolResultByIndex = new Map<number, { toolUseId: string; status?: string; payload?: Record<string, unknown> }>();
  const activeTools = new Map<string, { name: string; label: string; attempt: number; startedAt: number }>();
  const attemptsByTool = new Map<string, number>();
  const activeReasoning = new Map<number, { reasoningId: string; startedAt: number }>();
  const emittedMutations = new Set<string>();
  let reasoningSequence = 0;

  for await (const event of response.stream ?? []) {
    if (event.contentBlockDelta?.delta?.text) {
      yield { type: 'token', text: event.contentBlockDelta.delta.text };
    }

    if (event.contentBlockDelta?.delta?.reasoningContent
      && event.contentBlockDelta.contentBlockIndex !== undefined
      && !activeReasoning.has(event.contentBlockDelta.contentBlockIndex)) {
      reasoningSequence += 1;
      const reasoningId = `reasoning-${reasoningSequence}`;
      activeReasoning.set(event.contentBlockDelta.contentBlockIndex, {
        reasoningId,
        startedAt: Date.now(),
      });
      yield {
        type: 'reasoning_start',
        reasoningId,
        label: 'Analizando contexto y restricciones',
      };
    }

    const startToolUse = event.contentBlockStart?.start?.toolUse;
    if (startToolUse && event.contentBlockStart?.contentBlockIndex !== undefined) {
      const toolUseId = startToolUse.toolUseId ?? `tool-${event.contentBlockStart.contentBlockIndex}`;
      const name = toolNameFromHarness(startToolUse.name ?? 'unknown');
      const attempt = (attemptsByTool.get(name) ?? 0) + 1;
      const label = toolLabel(name);
      attemptsByTool.set(name, attempt);
      toolUseByIndex.set(event.contentBlockStart.contentBlockIndex, {
        toolUseId,
        name,
        inputJson: '',
      });
      activeTools.set(toolUseId, { name, label, attempt, startedAt: Date.now() });
      yield { type: 'tool_start', toolUseId, name, label, attempt };
    }

    const startToolResult = event.contentBlockStart?.start?.toolResult;
    if (startToolResult && event.contentBlockStart?.contentBlockIndex !== undefined) {
      toolResultByIndex.set(event.contentBlockStart.contentBlockIndex, {
        toolUseId: startToolResult.toolUseId ?? '',
        status: startToolResult.status,
      });
    }

    const toolUseDelta = event.contentBlockDelta?.delta?.toolUse;
    if (toolUseDelta?.input && event.contentBlockDelta?.contentBlockIndex !== undefined) {
      const current = toolUseByIndex.get(event.contentBlockDelta.contentBlockIndex);
      if (current) {
        current.inputJson += toolUseDelta.input;
      }
    }

    if (event.contentBlockStop?.contentBlockIndex !== undefined) {
      const reasoning = activeReasoning.get(event.contentBlockStop.contentBlockIndex);
      if (reasoning) {
        yield {
          type: 'reasoning_complete',
          reasoningId: reasoning.reasoningId,
          durationMs: Math.max(0, Date.now() - reasoning.startedAt),
        };
        activeReasoning.delete(event.contentBlockStop.contentBlockIndex);
      }

      const finished = toolUseByIndex.get(event.contentBlockStop.contentBlockIndex);
      if (finished?.name === 'propose_recategorize') {
        const input = tryParseJsonObject(finished.inputJson);
        const eventId = typeof input?.eventId === 'string' ? input.eventId : '';
        const categoryId = typeof input?.categoryId === 'string' ? input.categoryId : '';
        if (eventId && categoryId) {
          yield {
            type: 'proposal',
            kind: 'recategorize',
            eventId,
            categoryId,
            message: `Confirma recategorizar ${eventId} a ${categoryId}.`,
          };
        }
      }
      toolUseByIndex.delete(event.contentBlockStop.contentBlockIndex);

      const result = toolResultByIndex.get(event.contentBlockStop.contentBlockIndex);
      if (result) {
        const active = activeTools.get(result.toolUseId);
        if (active) {
          const durationMs = Math.max(0, Date.now() - active.startedAt);
          if (result.status === 'error') {
            yield {
              type: 'tool_failed',
              toolUseId: result.toolUseId,
              name: active.name,
              label: active.label,
              attempt: active.attempt,
              durationMs,
              message: `No se pudo completar: ${active.label.toLowerCase()}.`,
            };
          } else {
            const summary = result.payload ? summarizeToolResult(active.name, result.payload) : { material: false };
            yield {
              type: 'tool_complete',
              toolUseId: result.toolUseId,
              name: active.name,
              label: active.label,
              attempt: active.attempt,
              durationMs,
              ...summary,
            };
          }
          activeTools.delete(result.toolUseId);
        }
        toolResultByIndex.delete(event.contentBlockStop.contentBlockIndex);
      }
    }

    const toolResultDeltas = event.contentBlockDelta?.delta?.toolResult;
    if (Array.isArray(toolResultDeltas)) {
      const toolResultIndex = event.contentBlockDelta?.contentBlockIndex;
      for (const block of toolResultDeltas) {
        if (block.json && typeof block.json === 'object' && !Array.isArray(block.json)) {
          const payload = block.json as Record<string, unknown>;
          const result = toolResultIndex === undefined
            ? undefined
            : toolResultByIndex.get(toolResultIndex);
          if (result) result.payload = payload;
          const active = result ? activeTools.get(result.toolUseId) : undefined;
          const mutation = mutationFromToolResult(active?.name, payload);
          if (mutation) {
            const key = `${mutation.action}:${mutation.operationId}`;
            if (!emittedMutations.has(key)) {
              emittedMutations.add(key);
              yield mutation;
            }
          }
          yield* citationsFromPayload(payload);
        } else if (typeof block.text === 'string') {
          const parsed = tryParseJsonObject(block.text);
          if (parsed) {
            const result = toolResultIndex === undefined
              ? undefined
              : toolResultByIndex.get(toolResultIndex);
            if (result) result.payload = parsed;
            const active = result ? activeTools.get(result.toolUseId) : undefined;
            const mutation = mutationFromToolResult(active?.name, parsed);
            if (mutation) {
              const key = `${mutation.action}:${mutation.operationId}`;
              if (!emittedMutations.has(key)) {
                emittedMutations.add(key);
                yield mutation;
              }
            }
            yield* citationsFromPayload(parsed);
          }
        }
      }
    }

    if (event.validationException || event.internalServerException || event.runtimeClientError) {
      const detail = event.validationException?.message
        ?? event.internalServerException?.message
        ?? event.runtimeClientError?.message
        ?? 'Error de Harness';
      yield { type: 'error', message: 'No pude consultar tus datos. Reintenta.', requestId: detail };
      return;
    }
  }
}

export const runAgentChat = async function* (
  owner: string,
  month: string,
  message: string,
  sessionId: string,
  requestId: string,
): AsyncGenerator<AgentSseEvent> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      yield* invokeHarnessStream(owner, month, message, sessionId);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 2) break;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : 'Error desconocido';
  yield {
    type: 'error',
    message: 'No pude consultar tus datos. Reintenta.',
    requestId: `${requestId}:${detail.slice(0, 80)}`,
  };
};

export const collectAgentChat = async (
  owner: string,
  month: string,
  message: string,
  sessionId: string,
  requestId: string,
): Promise<AgentSseEvent[]> => {
  const events: AgentSseEvent[] = [];
  for await (const item of runAgentChat(owner, month, message, sessionId, requestId)) {
    events.push(item);
    if (item.type === 'error') return events;
  }
  events.push({ type: 'done', requestId, sessionId });
  return events;
};

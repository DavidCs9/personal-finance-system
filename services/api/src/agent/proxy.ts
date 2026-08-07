import { randomUUID } from 'node:crypto';
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { citationsFromToolResult, runAgentTool, TOOL_DEFINITIONS } from './tools.js';
import { principal } from '../http/response.js';

const modelId = process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-sonnet-4-6';
const harnessArn = process.env.HARNESS_ARN;
const bedrock = new BedrockRuntimeClient({});

const SYSTEM_PROMPT = `Eres el asistente de Olbia, el tablero personal de finanzas del usuario.

Voz: precisa, firme, útil, en segunda persona. Usa “Has gastado”, “Te quedan”, “Te faltarán”, “Neto”, “Debes”.
Frases cortas y montos concretos. Sin gamificación, sin celebrar gasto, sin lenguaje de bienestar, sin tono bancario corporativo.

Reglas:
- Todo número debe salir de una tool. No inventes ni estimes montos.
- Gasto por categoría usa la misma semántica que Resumen (cuota MSI del mes, no el ticket).
- Si hay monto sin categoría, dilo (“Hay $X / N movimientos sin categoría…”).
- Si falta dato, dilo con claridad.
- El mes por defecto es el que indique el usuario en el mensaje de sistema de contexto.
- System y tools están en español; puedes seguir el idioma de la pregunta del usuario.
- Si propones recategorizar, usa propose_recategorize; no digas que ya quedó aplicado.`;

type SseEvent =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'citation'; readonly kind: string; readonly id?: string; readonly label: string }
  | { readonly type: 'proposal'; readonly eventId: string; readonly categoryId: string; readonly message: string }
  | { readonly type: 'done'; readonly requestId: string; readonly sessionId: string }
  | { readonly type: 'error'; readonly message: string; readonly requestId: string };

const sse = (event: SseEvent): string => `data: ${JSON.stringify(event)}\n\n`;

const toolConfig = (): ToolConfiguration => ({
  tools: TOOL_DEFINITIONS.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema as Record<string, unknown> },
    },
  })) as ToolConfiguration['tools'],
});

const parseBody = (raw: string | undefined): {
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

const isTransient = (error: unknown): boolean => {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name: string }).name)
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return /throttl|timeout|temporar|429|503|ECONNRESET/i.test(`${name} ${message}`);
};

async function* converseLoop(
  owner: string,
  month: string,
  userMessage: string,
): AsyncGenerator<SseEvent> {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          text: `Contexto: mes activo del selector = ${month}. Si la pregunta nombra otro mes, ese gana.\n\nPregunta: ${userMessage}`,
        },
      ],
    },
  ];

  for (let round = 0; round < 8; round += 1) {
    const response = await bedrock.send(new ConverseStreamCommand({
      modelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      toolConfig: toolConfig(),
      inferenceConfig: { maxTokens: 2048, temperature: 0.2 },
    }));

    let assistantText = '';
    const toolUses: { toolUseId: string; name: string; input: Record<string, unknown> }[] = [];
    let currentTool: { toolUseId: string; name: string; inputJson: string } | undefined;
    let stopReason: string | undefined;

    for await (const event of response.stream ?? []) {
      if (event.contentBlockDelta?.delta?.text) {
        const text = event.contentBlockDelta.delta.text;
        assistantText += text;
        yield { type: 'token', text };
      }
      if (event.contentBlockStart?.start?.toolUse) {
        const start = event.contentBlockStart.start.toolUse;
        currentTool = {
          toolUseId: start.toolUseId ?? randomUUID(),
          name: start.name ?? '',
          inputJson: '',
        };
      }
      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        if (currentTool) currentTool.inputJson += event.contentBlockDelta.delta.toolUse.input;
      }
      if (event.contentBlockStop && currentTool) {
        let input: Record<string, unknown> = {};
        try {
          input = currentTool.inputJson ? JSON.parse(currentTool.inputJson) as Record<string, unknown> : {};
        } catch {
          input = {};
        }
        toolUses.push({
          toolUseId: currentTool.toolUseId,
          name: currentTool.name,
          input,
        });
        currentTool = undefined;
      }
      if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
    }

    const assistantContent: ContentBlock[] = [];
    if (assistantText) assistantContent.push({ text: assistantText });
    for (const tool of toolUses) {
      assistantContent.push({
        toolUse: {
          toolUseId: tool.toolUseId,
          name: tool.name,
          input: tool.input as never,
        },
      });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    if (stopReason !== 'tool_use' || toolUses.length === 0) return;

    const toolResults: ContentBlock[] = [];
    for (const tool of toolUses) {
      const result = await runAgentTool(owner, tool.name, {
        month,
        ...tool.input,
      });
      for (const citation of citationsFromToolResult(tool.name, result)) {
        yield { type: 'citation', ...citation };
      }
      if (tool.name === 'propose_recategorize' && result && typeof result === 'object') {
        const proposal = result as { eventId: string; categoryId: string; message: string };
        yield {
          type: 'proposal',
          eventId: proposal.eventId,
          categoryId: proposal.categoryId,
          message: proposal.message,
        };
      }
      toolResults.push({
        toolResult: {
          toolUseId: tool.toolUseId,
          content: [{ json: result as never }],
        },
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }
}

const runWithRetries = async function* (
  owner: string,
  month: string,
  message: string,
  requestId: string,
): AsyncGenerator<SseEvent> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (harnessArn) {
        // Harness path: same tool surface via Gateway in production.
        // Until HARNESS_ARN is wired to a READY harness, Converse fallback below still applies if invoke fails.
        yield* converseLoop(owner, month, message);
      } else {
        yield* converseLoop(owner, month, message);
      }
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
    requestId: `${requestId}:${detail.slice(0, 40)}`,
  };
};

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId || randomUUID();
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'POST' && path.endsWith('/agent/chat')) {
    try {
      const owner = principal(event);
      const body = parseBody(event.body);
      // Response streaming for Lambda Function URL / HTTP API payload format 2.0
      // Consumers read `body` as SSE text when awslambda.streamifyResponse is unavailable
      // in this bundling path; we still return a single SSE document assembled from the generator.
      let payload = '';
      let sessionId = body.sessionId;
      for await (const item of runWithRetries(owner, body.month, body.message, requestId)) {
        payload += sse(item);
        if (item.type === 'error') {
          return {
            statusCode: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              'x-request-id': requestId,
            },
            body: payload,
          };
        }
      }
      payload += sse({ type: 'done', requestId, sessionId });
      return {
        statusCode: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-request-id': requestId,
        },
        body: payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No pude consultar tus datos.';
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
        body: JSON.stringify({ message, requestId }),
      };
    }
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ message: 'Route not found.' }),
  };
};

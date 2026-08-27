import { describe, expect, it } from 'vitest';
import {
  buildHarnessModelConfig,
  buildHarnessSystemPrompt,
  readBody,
  requiresTravelPlanRecalculation,
  requestIdOf,
  requestMethod,
  resolveOwner,
  summarizeToolResult,
  type AgentChatGatewayEvent,
} from './chat-core.js';

const restApiEvent = (): AgentChatGatewayEvent => ({
  body: Buffer.from('{"message":"hola"}').toString('base64'),
  isBase64Encoded: true,
  headers: {},
  httpMethod: 'POST',
  requestContext: {
    requestId: 'rest-request-1',
    authorizer: { claims: { sub: 'cognito-owner-sub' } },
  },
});

describe('REST API Gateway chat event helpers', () => {
  it('uses the REST Cognito authorizer subject without re-verifying the bearer token', async () => {
    await expect(resolveOwner(restApiEvent())).resolves.toBe('cognito-owner-sub');
  });

  it('reads REST API request metadata and body', () => {
    const event = restApiEvent();
    expect(requestMethod(event)).toBe('POST');
    expect(requestIdOf(event)).toBe('rest-request-1');
    expect(readBody(event)).toBe('{"message":"hola"}');
  });

  it('creates audit summaries without exposing raw tool rows', () => {
    expect(summarizeToolResult('list_movements', {
      movements: [{ merchantRaw: 'Mercado' }, { merchantRaw: 'Farmacia' }],
    })).toEqual({ summary: 'Revisé 2 movimientos.', material: true });
    expect(summarizeToolResult('propose_recategorize', {
      eventId: 'private-event-id',
      categoryId: 'food',
    })).toEqual({ summary: 'Propuesta de categoría preparada.', material: false });
    expect(summarizeToolResult('preview_bulk_edit', {
      movementCount: 18,
    })).toEqual({ summary: 'Preparé 18 movimientos para confirmar.', material: false });
  });
});

describe('Harness reasoning and travel planning configuration', () => {
  it('enables bounded adaptive thinking for Claude Sonnet 4.6 without temperature', () => {
    expect(buildHarnessModelConfig({
      modelId: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 2_048,
      temperature: 0.2,
    })).toEqual({
      modelId: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 4_096,
      apiFormat: 'converse_stream',
      additionalParams: {
        additionalModelRequestFields: {
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
        },
      },
    });
  });

  it('adds a current-turn recalculation directive for the reported regression', () => {
    const message = 'no el tramo de CDMX es del 26 al 30. El 26 vuelo de tijuana a CDMX. Primero hay que acabar con las vegas';
    expect(requiresTravelPlanRecalculation(message)).toBe(true);
    const prompt = buildHarnessSystemPrompt('Prompt base.', message);
    expect(prompt).toContain('Este turno continua una decision de presupuesto');
    expect(prompt).toContain('vuelve a usar plan_month_scenario');
    expect(prompt).toContain('Nunca preguntes cuanto quiere gastar');
    expect(prompt).toContain('salida de Las Vegas hacia Tijuana');
  });

  it('does not add the travel directive to unrelated questions', () => {
    expect(buildHarnessSystemPrompt('Prompt base.', 'Cuanto gaste en restaurantes?')).toBe('Prompt base.');
  });
});

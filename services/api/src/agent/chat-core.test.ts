import { describe, expect, it } from 'vitest';
import {
  buildHarnessModelConfig,
  buildHarnessSystemPrompt,
  agentChatErrorStatus,
  assertConfiguredAgentOwner,
  mutationFromToolResult,
  mutationsFromToolResult,
  readBody,
  requiresTravelPlanRecalculation,
  requestIdOf,
  requestMethod,
  resolveOwner,
  summarizeToolResult,
  toolNameFromHarness,
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
    expect(summarizeToolResult('preview_category_edit', {
      movementCount: 18,
    })).toEqual({ summary: 'Preparé 18 movimientos.', material: false });
    expect(summarizeToolResult('preview_tag_edit', {
      movementCount: 18,
    })).toEqual({ summary: 'Preparé 18 movimientos.', material: false });
    expect(summarizeToolResult('apply_tag_edit', {
      movementCount: 18,
    })).toEqual({ summary: 'Actualicé 18 movimientos.', material: true });
  });

  it('normalizes target-qualified Harness tool names before lifecycle handling', () => {
    expect(toolNameFromHarness('olbia-tag-mutations___apply_tag_edit')).toBe('apply_tag_edit');
    expect(toolNameFromHarness('month_snapshot')).toBe('month_snapshot');
  });

  it('maps successful tag mutations to a factual SSE receipt', () => {
    expect(mutationFromToolResult('apply_tag_edit', {
      operationId: 'operation-1',
      movementCount: 18,
      amountMinor: 923_214,
      fromDay: '2026-08-21',
      toDay: '2026-08-25',
      change: { addTags: ['viaje:vegas'] },
    })).toEqual({
      type: 'mutation',
      kind: 'tag_edit',
      action: 'applied',
      operationId: 'operation-1',
      movementCount: 18,
      amountMinor: 923_214,
      fromDay: '2026-08-21',
      toDay: '2026-08-25',
      change: { addTags: ['viaje:vegas'] },
    });
    expect(mutationFromToolResult('preview_tag_edit', { operationId: 'operation-1' })).toBeUndefined();
    expect(mutationFromToolResult('apply_category_edit', {
      operationId: 'operation-2',
      movementCount: 3,
      amountMinor: 20_000,
      fromDay: '2026-08-21',
      toDay: '2026-08-25',
      change: { categoryId: 'food' },
    })).toMatchObject({ kind: 'category_edit', action: 'applied', change: { categoryId: 'food' } });
    expect(mutationsFromToolResult('apply_category_edits', {
      operations: [
        { operationId: 'operation-3', movementCount: 1, amountMinor: 10_000, fromDay: '2026-08-21', toDay: '2026-08-21', change: { categoryId: 'food' } },
        { operationId: 'operation-4', movementCount: 2, amountMinor: 20_000, fromDay: '2026-08-25', toDay: '2026-08-25', change: { categoryId: 'food' } },
      ],
    })).toMatchObject([
      { operationId: 'operation-3', kind: 'category_edit', action: 'applied' },
      { operationId: 'operation-4', kind: 'category_edit', action: 'applied' },
    ]);
    expect(mutationsFromToolResult('apply_tag_edits', {
      operations: [
        { operationId: 'operation-5', movementCount: 1, amountMinor: 10_000, fromDay: '2026-08-21', toDay: '2026-08-21', change: { addTags: ['viaje:vegas'] } },
        { operationId: 'operation-6', movementCount: 2, amountMinor: 20_000, fromDay: '2026-08-25', toDay: '2026-08-25', change: { removeTags: ['trabajo'] } },
      ],
    })).toMatchObject([
      { operationId: 'operation-5', kind: 'tag_edit', action: 'applied' },
      { operationId: 'operation-6', kind: 'tag_edit', action: 'applied' },
    ]);
  });

  it('rejects any Cognito user other than the configured ledger owner', () => {
    try {
      process.env.AGENT_OWNER = 'owner-1';
      expect(() => assertConfiguredAgentOwner('owner-1')).not.toThrow();
      try {
        assertConfiguredAgentOwner('owner-2');
        throw new Error('Expected owner guard to throw.');
      } catch (error) {
        expect(agentChatErrorStatus(error)).toBe(403);
      }
    } finally {
      delete process.env.AGENT_OWNER;
    }
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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore';

const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-agentcore', async importOriginal => ({
  ...await importOriginal<typeof import('@aws-sdk/client-bedrock-agentcore')>(),
  BedrockAgentCoreClient: class { send = mock.send; },
}));
vi.mock('./prompt-runtime.js', () => ({ resolveRuntimePrompt: async () => ({
  text: 'test-managed-prompt', modelId: 'us.anthropic.claude-sonnet-4-6', maxTokens: 8192, temperature: 0.2,
}) }));
let core: typeof import('./chat-core.js');
beforeAll(async () => {
  vi.stubEnv('HARNESS_ARN', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test');
  core = await import('./chat-core.js');
});
beforeEach(() => mock.send.mockReset());
afterAll(() => vi.unstubAllEnvs());
const stream = async function* (events: InvokeHarnessStreamOutput[]) { yield* events; };
const collect = async (events: InvokeHarnessStreamOutput[]) => {
  const output = [];
  for await (const event of core.harnessStreamEvents(stream(events), 'request-1')) output.push(event);
  return output;
};

describe('native Harness stream outcomes', () => {
  it('buffers split JSON tool results and emits receipts only after the complete result closes', async () => {
    const payload = JSON.stringify({ operationId: 'op-1', movementCount: 1, amountMinor: 100,
      fromDay: '2026-10-01', toDay: '2026-10-01', change: { categoryId: 'shopping' } });
    const opening: InvokeHarnessStreamOutput[] = [
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't1', name: 'apply_category_edit' } } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolResult: { toolUseId: 't1', status: 'success' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ text: payload.slice(0, 50) }] } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ text: payload.slice(50) }] } } },
    ];
    const interrupted = await collect(opening);
    expect(interrupted.some(event => event.type === 'mutation')).toBe(false);
    const completed = await collect([...opening,
      { contentBlockStop: { contentBlockIndex: 1 } }, { messageStop: { stopReason: 'end_turn' } }]);
    expect(completed.filter(event => event.type === 'mutation')).toMatchObject([{ operationId: 'op-1' }]);
    expect(completed.some(event => event.type === 'error')).toBe(false);
    const invalid = JSON.stringify({ ok: false, status: 'invalid_request', message: 'Referencia ambigua.' });
    const rejected = await collect([...opening.slice(0, 2),
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ text: invalid.slice(0, 10) }] } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ text: invalid.slice(10) }] } } },
      { contentBlockStop: { contentBlockIndex: 1 } }, { messageStop: { stopReason: 'end_turn' } }]);
    expect(rejected.filter(event => event.type === 'tool_failed')).toHaveLength(1);
    expect(rejected.some(event => event.type === 'mutation')).toBe(false);
  });

  it('marks recoverable domain rejections as failed activity even when Gateway transport succeeds', async () => {
    const result = await collect([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't1', name: 'olbia-tag-mutations___preview_category_edit' } } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolResult: { toolUseId: 't1', status: 'success' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ json: { ok: false, status: 'invalid_request', message: 'Consulta el catálogo.' } }] } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    expect(result.filter(event => event.type === 'tool_failed')).toHaveLength(1);
    expect(result.some(event => event.type === 'tool_complete' || event.type === 'mutation' || event.type === 'error')).toBe(false);
  });

  it.each(['max_tokens', 'max_iterations_exceeded', 'timeout_exceeded', 'max_output_tokens_exceeded'] as const)(
    'keeps %s incomplete and closes activity without exposing reasoning', async stopReason => {
      const result = await collect([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'private-thought' } } } },
        { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'preview_category_edit' } } } },
        { messageStop: { stopReason } },
      ]);
      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning_complete' }), expect.objectContaining({ type: 'tool_failed' }),
        expect.objectContaining({ type: 'error', requestId: 'request-1', message: expect.stringContaining('continúa') }),
      ]));
      expect(JSON.stringify(result)).not.toContain('private-thought');
      expect(result.some(event => event.type === 'done')).toBe(false);
    },
  );

  it('does not call an abruptly ended stream a completed answer', async () => {
    const result = await collect([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Parcial' } } }]);
    expect(result.at(-1)).toMatchObject({ type: 'error' });
  });

  it('never replays a request after a streamed mutation and transport failure', async () => {
    const failing = async function* (): AsyncGenerator<InvokeHarnessStreamOutput> {
      yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't1', name: 'apply_category_edit' } } } };
      yield { contentBlockStart: { contentBlockIndex: 1, start: { toolResult: { toolUseId: 't1', status: 'success' } } } };
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ json: {
        operationId: 'op-1', movementCount: 1, amountMinor: 100, fromDay: '2026-10-01', toDay: '2026-10-01', change: { categoryId: 'shopping' },
      } }] } } };
      yield { contentBlockStop: { contentBlockIndex: 1 } };
      throw new Error('ECONNRESET private diagnostic');
    };
    mock.send.mockResolvedValue({ stream: failing() });
    const events = await core.collectAgentChat('owner', '2026-10', 'clasifica', 'session', 'request-1');
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.send.mock.calls[0]![0].input).toMatchObject({ maxTokens: 8192, maxIterations: 25, timeoutSeconds: 270,
      runtimeSessionId: 'session', actorId: 'owner', model: { bedrockModelConfig: { maxTokens: 8192 } } });
    expect(events.filter(event => event.type === 'mutation')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', requestId: 'request-1' });
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private diagnostic');
  });
});

import {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  CreateHarnessCommand,
  CreateMemoryCommand,
  DeleteGatewayCommand,
  DeleteGatewayTargetCommand,
  DeleteHarnessCommand,
  DeleteMemoryCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  GetHarnessCommand,
  GetMemoryCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  ListHarnessesCommand,
  ListMemoriesCommand,
  UpdateMemoryCommand,
  UpdateGatewayTargetCommand,
  UpdateHarnessCommand,
  type Memory,
  type ToolDefinition,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { resolveRuntimePrompt, type RuntimePrompt } from './prompt-runtime.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

const control = new BedrockAgentCoreControlClient({
  region: process.env.AGENTCORE_REGION?.trim() || undefined,
});
const financeControl = new BedrockAgentCoreControlClient({
  region: process.env.AWS_REGION?.trim() || undefined,
});

interface ProviderEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResourceProperties: {
    readonly HarnessName?: string;
    readonly GatewayName?: string;
    readonly FinanceGatewayName?: string;
    readonly TargetName?: string;
    readonly WebSearchTargetName?: string;
    readonly HarnessExecutionRoleArn?: string;
    readonly GatewayRoleArn?: string;
    readonly ToolsLambdaArn?: string;
    readonly MemoryName?: string;
    readonly MemoryExecutionRoleArn?: string;
    readonly MemoryModelId?: string;
  };
  readonly PhysicalResourceId?: string;
  readonly OldResourceProperties?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <T extends { status?: string; failureReason?: string }>(
  label: string,
  read: () => Promise<T>,
  ready: readonly string[],
  failed: readonly string[],
  timeoutMs = 10 * 60_000,
): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const current = await read();
    const status = current.status ?? '';
    if (ready.includes(status)) return current;
    if (failed.includes(status)) {
      const reason = current.failureReason ? `: ${current.failureReason}` : '';
      throw new Error(`${label} entered terminal status ${status}${reason}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${label} timed out waiting for READY (last=${status})`);
    }
    await sleep(5_000);
  }
};

const findGatewayIdByName = async (
  client: BedrockAgentCoreControlClient,
  name: string,
): Promise<string | undefined> => {
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListGatewaysCommand({ maxResults: 50, nextToken }));
    const match = page.items?.find((item) => item.name === name);
    if (match?.gatewayId) return match.gatewayId;
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
};

const findHarnessIdByName = async (name: string): Promise<string | undefined> => {
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListHarnessesCommand({ maxResults: 50, nextToken }));
    const match = page.harnesses?.find((item) => item.harnessName === name);
    if (match?.harnessId) return match.harnessId;
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
};

const findMemoryIdByName = async (name: string): Promise<string | undefined> => {
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListMemoriesCommand({ maxResults: 100, nextToken }));
    const match = page.memories?.find((item) =>
      item.id?.startsWith(`${name}-`)
      && item.status !== 'DELETING'
      && item.status !== 'FAILED');
    if (match?.id) return match.id;
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
};

type AgentCoreResourceIds = {
  readonly harnessId?: string;
  readonly gatewayId?: string;
  readonly targetId?: string;
  readonly webSearchTargetId?: string;
  readonly memoryId?: string;
};

/**
 * V2 physical IDs own exact AgentCore resources. Legacy IDs only held a memory
 * ID, so deleting one must never fall back to a name lookup: a replacement may
 * have already created resources with the same names.
 */
const resourceIdsFromPhysicalId = (physicalId: string | undefined): AgentCoreResourceIds => {
  const parts = physicalId?.split('::') ?? [];
  if (parts[0] === 'olbia-agentcore-v3') {
    return {
      harnessId: parts[1],
      gatewayId: parts[2],
      targetId: parts[3],
      webSearchTargetId: parts[4],
      memoryId: parts[5],
    };
  }
  if (parts[0] === 'olbia-agentcore-v2') {
    return {
      harnessId: parts[1],
      gatewayId: parts[2],
      targetId: parts[3],
      memoryId: parts[4],
    };
  }
  return { memoryId: parts[1] };
};

const isNotFound = (error: unknown): boolean => {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name: string }).name)
    : '';
  return /ResourceNotFound|NotFound/i.test(name);
};

const VERIFIED_FACTS_STRATEGY = 'OlbiaVerifiedFacts';
const VERIFIED_PREFERENCES_STRATEGY = 'OlbiaVerifiedPreferences';

const verifiedMemoryStrategies = (modelId: string) => ([
  {
    customMemoryStrategy: {
      name: VERIFIED_FACTS_STRATEGY,
      description: 'Durable facts explicitly stated or corrected by the user.',
      namespaceTemplates: ['/users/{actorId}/facts/'],
      configuration: {
        semanticOverride: {
          extraction: {
            modelId,
            appendToPrompt: [
              'Store only durable facts explicitly stated by the user.',
              'Never store assistant claims, assistant calculations, intermediate planning values, current balances, projections, inferred dates, or an unconfirmed currency or unit.',
              'Preserve the exact currency, unit, and date precision stated by the user.',
              'When the user corrects a fact, treat the correction as authoritative and reject the older value.',
            ].join(' '),
          },
          consolidation: {
            modelId,
            appendToPrompt: [
              'Consolidate only explicit user facts.',
              'Replace contradicted facts with the latest user correction instead of retaining both.',
              'Do not turn assistant reasoning, arithmetic, uncertainty, or temporary plans into facts.',
            ].join(' '),
          },
        },
      },
    },
  },
  {
    customMemoryStrategy: {
      name: VERIFIED_PREFERENCES_STRATEGY,
      description: 'Stable preferences explicitly expressed by the user.',
      namespaceTemplates: ['/users/{actorId}/preferences/'],
      configuration: {
        userPreferenceOverride: {
          extraction: {
            modelId,
            appendToPrompt: [
              'Store only stable preferences explicitly expressed by the user.',
              'Do not infer a preference from one decision, an assistant suggestion, a current balance, a trip calculation, a temporary constraint, or silence.',
              'Never store assistant-authored conclusions as user preferences.',
              'A later explicit user correction supersedes an older preference.',
            ].join(' '),
          },
          consolidation: {
            modelId,
            appendToPrompt: [
              'Keep only explicit, durable user preferences.',
              'Replace contradicted preferences with the latest explicit user statement.',
              'Remove assistant inferences and temporary planning details during consolidation.',
            ].join(' '),
          },
        },
      },
    },
  },
]);

type VerifiedMemory = {
  readonly memoryId: string;
  readonly memoryArn: string;
  readonly factsStrategyId: string;
  readonly preferencesStrategyId: string;
};

const activeVerifiedMemory = (
  memory: Pick<Memory, 'arn' | 'strategies'>,
  memoryId: string,
): VerifiedMemory | undefined => {
  const facts = memory.strategies?.find((strategy) =>
    strategy.name === VERIFIED_FACTS_STRATEGY && strategy.status === 'ACTIVE');
  const preferences = memory.strategies?.find((strategy) =>
    strategy.name === VERIFIED_PREFERENCES_STRATEGY && strategy.status === 'ACTIVE');
  if (!memory.arn || !facts?.strategyId || !preferences?.strategyId) return undefined;
  return {
    memoryId,
    memoryArn: memory.arn,
    factsStrategyId: facts.strategyId,
    preferencesStrategyId: preferences.strategyId,
  };
};

const reconcileVerifiedMemory = async (input: {
  readonly memoryId: string;
  readonly executionRoleArn: string;
  readonly modelId: string;
}): Promise<VerifiedMemory> => {
  let response = await control.send(new GetMemoryCommand({ memoryId: input.memoryId }));
  let memory = response.memory;
  if (!memory) throw new Error(`Memory ${input.memoryId} was not returned.`);
  const names = new Set(memory.strategies?.map((strategy) => strategy.name));
  if (!names.has(VERIFIED_FACTS_STRATEGY) || !names.has(VERIFIED_PREFERENCES_STRATEGY)) {
    const desired = verifiedMemoryStrategies(input.modelId).filter((strategy) =>
      !names.has(strategy.customMemoryStrategy.name));
    await control.send(new UpdateMemoryCommand({
      memoryId: input.memoryId,
      memoryExecutionRoleArn: input.executionRoleArn,
      memoryStrategies: { addMemoryStrategies: desired },
    }));
    const ready = await waitUntil(
      'memory-strategy-add',
      async () => {
        const current = await control.send(new GetMemoryCommand({ memoryId: input.memoryId }));
        const desiredActive = [VERIFIED_FACTS_STRATEGY, VERIFIED_PREFERENCES_STRATEGY].every(
          (name) => current.memory?.strategies?.some((strategy) =>
            strategy.name === name && strategy.status === 'ACTIVE'),
        );
        const desiredFailed = current.memory?.strategies?.some((strategy) =>
          (strategy.name === VERIFIED_FACTS_STRATEGY || strategy.name === VERIFIED_PREFERENCES_STRATEGY)
          && strategy.status === 'FAILED');
        return {
          status: desiredFailed
            ? 'FAILED'
            : current.memory?.status === 'ACTIVE'
            ? (desiredActive ? 'ACTIVE' : 'UPDATING_STRATEGIES')
            : current.memory?.status,
          memory: current.memory,
        };
      },
      ['ACTIVE'],
      ['FAILED'],
    );
    memory = ready.memory;
    if (!memory) throw new Error('Memory active after strategy add without details.');
  } else if (memory.memoryExecutionRoleArn !== input.executionRoleArn) {
    await control.send(new UpdateMemoryCommand({
      memoryId: input.memoryId,
      memoryExecutionRoleArn: input.executionRoleArn,
    }));
    const ready = await waitUntil(
      'memory-role-update',
      async () => {
        const current = await control.send(new GetMemoryCommand({ memoryId: input.memoryId }));
        return {
          status: current.memory?.status === 'ACTIVE'
            ? (current.memory.memoryExecutionRoleArn === input.executionRoleArn ? 'ACTIVE' : 'UPDATING_ROLE')
            : current.memory?.status,
          memory: current.memory,
        };
      },
      ['ACTIVE'],
      ['FAILED'],
    );
    memory = ready.memory;
    if (!memory) throw new Error('Memory active after role update without details.');
  }

  const obsolete = memory.strategies?.filter((strategy) =>
    strategy.name !== VERIFIED_FACTS_STRATEGY
    && strategy.name !== VERIFIED_PREFERENCES_STRATEGY
    && strategy.strategyId) ?? [];
  if (obsolete.length > 0) {
    await control.send(new UpdateMemoryCommand({
      memoryId: input.memoryId,
      memoryStrategies: {
        deleteMemoryStrategies: obsolete.map((strategy) => ({
          memoryStrategyId: strategy.strategyId!,
        })),
      },
    }));
    const ready = await waitUntil(
      'memory-strategy-delete',
      async () => {
        const current = await control.send(new GetMemoryCommand({ memoryId: input.memoryId }));
        const obsoleteRemain = current.memory?.strategies?.some((strategy) =>
          strategy.name !== VERIFIED_FACTS_STRATEGY
          && strategy.name !== VERIFIED_PREFERENCES_STRATEGY);
        const desiredFailed = current.memory?.strategies?.some((strategy) =>
          (strategy.name === VERIFIED_FACTS_STRATEGY || strategy.name === VERIFIED_PREFERENCES_STRATEGY)
          && strategy.status === 'FAILED');
        return {
          status: desiredFailed
            ? 'FAILED'
            : current.memory?.status === 'ACTIVE'
            ? (!obsoleteRemain ? 'ACTIVE' : 'UPDATING_STRATEGIES')
            : current.memory?.status,
          memory: current.memory,
        };
      },
      ['ACTIVE'],
      ['FAILED'],
    );
    memory = ready.memory;
    if (!memory) throw new Error('Memory active after strategy delete without details.');
  }

  const verified = activeVerifiedMemory(memory, input.memoryId);
  if (!verified) throw new Error('Verified memory strategies did not become ACTIVE.');
  return verified;
};

const ensureMemory = async (input: {
  readonly name: string;
  readonly executionRoleArn: string;
  readonly modelId: string;
  readonly existingId?: string;
}): Promise<VerifiedMemory> => {
  // Prefer a same-region name match during regional migrations; the physical ID
  // may still refer to the previous region until CloudFormation accepts v3.
  const reusableId = await findMemoryIdByName(input.name) ?? input.existingId;
  if (reusableId) {
    try {
      const existing = await control.send(new GetMemoryCommand({ memoryId: reusableId }));
      if (existing.memory?.status === 'ACTIVE' && existing.memory.arn) {
        return reconcileVerifiedMemory({
          memoryId: reusableId,
          executionRoleArn: input.executionRoleArn,
          modelId: input.modelId,
        });
      }
      if (existing.memory?.status !== 'DELETING' && existing.memory?.status !== 'FAILED') {
        const ready = await waitUntil(
          'memory',
          async () => {
            const response = await control.send(new GetMemoryCommand({ memoryId: reusableId }));
            return { status: response.memory?.status, memory: response.memory };
          },
          ['ACTIVE'],
          ['FAILED'],
        );
        if (!ready.memory?.arn) throw new Error('Memory active without ARN.');
        return reconcileVerifiedMemory({
          memoryId: reusableId,
          executionRoleArn: input.executionRoleArn,
          modelId: input.modelId,
        });
      }
    } catch (error) {
      // A previous failed replacement can leave a Harness with a stale Memory ARN.
      // Recreate it below and repoint the existing Harness during this update.
      if (!isNotFound(error)) throw error;
    }
  }
  const created = await control.send(new CreateMemoryCommand({
    name: input.name,
    description: 'Durable, user-scoped conversational memory for the Olbia assistant.',
    // Raw events are short-lived; extracted long-term facts persist until the user deletes them.
    eventExpiryDuration: 30,
    memoryExecutionRoleArn: input.executionRoleArn,
    memoryStrategies: verifiedMemoryStrategies(input.modelId),
  }));
  const memoryId = created.memory?.id;
  if (!memoryId) throw new Error('CreateMemory did not return memory ID.');
  const ready = await waitUntil(
    'memory',
    async () => {
      const response = await control.send(new GetMemoryCommand({ memoryId }));
      return { status: response.memory?.status, memory: response.memory };
    },
    ['ACTIVE'],
    ['FAILED'],
  );
  if (!ready.memory?.arn) throw new Error('Memory active without ARN.');
  return reconcileVerifiedMemory({
    memoryId,
    executionRoleArn: input.executionRoleArn,
    modelId: input.modelId,
  });
};

const toolSchemaInline = (): ToolDefinition[] =>
  JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as ToolDefinition[];

const ensureGateway = async (input: {
  readonly name: string;
  readonly roleArn: string;
}): Promise<{ gatewayId: string; gatewayArn: string }> => {
  const existingId = await findGatewayIdByName(control, input.name);
  if (existingId) {
    const existing = await control.send(new GetGatewayCommand({ gatewayIdentifier: existingId }));
    if (existing.status === 'READY') {
      return { gatewayId: existingId, gatewayArn: existing.gatewayArn! };
    }
    if (existing.status !== 'DELETING') {
      await control.send(new DeleteGatewayCommand({ gatewayIdentifier: existingId }));
    }
    const started = Date.now();
    for (;;) {
      try {
        const current = await control.send(new GetGatewayCommand({ gatewayIdentifier: existingId }));
        if (current.status !== 'DELETING' && current.status !== 'FAILED') {
          // Unexpected leftover — keep waiting until gone or throw later.
        }
      } catch (error) {
        const name = error && typeof error === 'object' && 'name' in error
          ? String((error as { name: string }).name)
          : '';
        if (/ResourceNotFound|NotFound/i.test(name)) break;
        throw error;
      }
      if (Date.now() - started > 5 * 60_000) {
        throw new Error(`Timed out deleting failed gateway ${existingId}`);
      }
      await sleep(5_000);
    }
  }
  const created = await control.send(new CreateGatewayCommand({
    name: input.name,
    description: 'Olbia managed web search gateway for AgentCore Harness.',
    roleArn: input.roleArn,
    protocolType: 'MCP',
    authorizerType: 'AWS_IAM',
  }));
  const ready = await waitUntil(
    'gateway',
    async () => control.send(new GetGatewayCommand({ gatewayIdentifier: created.gatewayId! })),
    ['READY'],
    ['FAILED', 'UPDATE_UNSUCCESSFUL'],
  );
  return { gatewayId: created.gatewayId!, gatewayArn: ready.gatewayArn! };
};

const resolveFinanceGateway = async (name: string): Promise<{
  gatewayId: string;
  gatewayArn: string;
}> => {
  const gatewayId = await findGatewayIdByName(financeControl, name);
  if (!gatewayId) {
    throw new Error(`Existing finance Gateway ${name} was not found in ${process.env.AWS_REGION}.`);
  }
  const gateway = await financeControl.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
  if (gateway.status !== 'READY' || !gateway.gatewayArn) {
    throw new Error(`Finance Gateway ${name} is not READY (status=${gateway.status ?? 'unknown'}).`);
  }
  return { gatewayId, gatewayArn: gateway.gatewayArn };
};

const ensureGatewayTarget = async (input: {
  readonly gatewayId: string;
  readonly name: string;
  readonly toolsLambdaArn: string;
}): Promise<string> => {
  let nextToken: string | undefined;
  do {
    const page = await financeControl.send(new ListGatewayTargetsCommand({
      gatewayIdentifier: input.gatewayId,
      maxResults: 50,
      nextToken,
    }));
    const match = page.items?.find((item) => item.name === input.name);
    if (match?.targetId) {
      await financeControl.send(new UpdateGatewayTargetCommand({
        gatewayIdentifier: input.gatewayId,
        targetId: match.targetId,
        name: input.name,
        description: 'Olbia ledger aggregation tools.',
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: input.toolsLambdaArn,
              toolSchema: { inlinePayload: toolSchemaInline() },
            },
          },
        },
        credentialProviderConfigurations: [
          { credentialProviderType: 'GATEWAY_IAM_ROLE' },
        ],
      }));
      await waitUntil(
        'gateway-target',
        async () => financeControl.send(new GetGatewayTargetCommand({
          gatewayIdentifier: input.gatewayId,
          targetId: match.targetId!,
        })),
        ['READY'],
        ['FAILED', 'UPDATE_UNSUCCESSFUL', 'SYNCHRONIZE_UNSUCCESSFUL'],
      );
      return match.targetId;
    }
    nextToken = page.nextToken;
  } while (nextToken);

  const created = await financeControl.send(new CreateGatewayTargetCommand({
    gatewayIdentifier: input.gatewayId,
    name: input.name,
    description: 'Olbia ledger aggregation tools.',
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn: input.toolsLambdaArn,
          toolSchema: {
            inlinePayload: toolSchemaInline(),
          },
        },
      },
    },
    credentialProviderConfigurations: [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ],
  }));
  await waitUntil(
    'gateway-target',
    async () => financeControl.send(new GetGatewayTargetCommand({
      gatewayIdentifier: input.gatewayId,
      targetId: created.targetId!,
    })),
    ['READY'],
    ['FAILED', 'UPDATE_UNSUCCESSFUL', 'SYNCHRONIZE_UNSUCCESSFUL'],
  );
  return created.targetId!;
};

const ensureWebSearchTarget = async (input: {
  readonly gatewayId: string;
  readonly name: string;
}): Promise<string> => {
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListGatewayTargetsCommand({
      gatewayIdentifier: input.gatewayId,
      maxResults: 50,
      nextToken,
    }));
    const match = page.items?.find((item) => item.name === input.name);
    if (match?.targetId) {
      await waitUntil(
        'web-search-target',
        async () => control.send(new GetGatewayTargetCommand({
          gatewayIdentifier: input.gatewayId,
          targetId: match.targetId!,
        })),
        ['READY'],
        ['FAILED', 'UPDATE_UNSUCCESSFUL', 'SYNCHRONIZE_UNSUCCESSFUL'],
      );
      return match.targetId;
    }
    nextToken = page.nextToken;
  } while (nextToken);

  const created = await control.send(new CreateGatewayTargetCommand({
    gatewayIdentifier: input.gatewayId,
    name: input.name,
    description: 'AWS-managed web search with source citations for Olbia.',
    targetConfiguration: {
      mcp: {
        connector: {
          source: { connectorId: 'web-search' },
          enabled: ['WebSearch'],
          configurations: [{ name: 'WebSearch', parameterValues: {} }],
        },
      },
    },
    credentialProviderConfigurations: [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ],
  }));
  await waitUntil(
    'web-search-target',
    async () => control.send(new GetGatewayTargetCommand({
      gatewayIdentifier: input.gatewayId,
      targetId: created.targetId!,
    })),
    ['READY'],
    ['FAILED', 'UPDATE_UNSUCCESSFUL', 'SYNCHRONIZE_UNSUCCESSFUL'],
  );
  return created.targetId!;
};

const harnessTools = (financeGatewayArn: string, webGatewayArn: string) => ([
  {
    type: 'agentcore_gateway' as const,
    name: 'olbia-finance',
    config: {
      agentCoreGateway: {
        gatewayArn: financeGatewayArn,
        outboundAuth: { awsIam: {} },
      },
    },
  },
  {
    type: 'agentcore_gateway' as const,
    name: 'olbia-web-search',
    config: {
      agentCoreGateway: {
        gatewayArn: webGatewayArn,
        outboundAuth: { awsIam: {} },
      },
    },
  },
]);

const harnessModel = (prompt: RuntimePrompt) => ({
  bedrockModelConfig: {
    modelId: prompt.modelId,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    apiFormat: 'converse_stream' as const,
  },
});

const ensureHarness = async (input: {
  readonly name: string;
  readonly executionRoleArn: string;
  readonly financeGatewayArn: string;
  readonly webGatewayArn: string;
  readonly prompt: RuntimePrompt;
  readonly memoryArn: string;
  readonly factsStrategyId: string;
  readonly preferencesStrategyId: string;
}): Promise<{ harnessId: string; harnessArn: string }> => {
  const model = harnessModel(input.prompt);
  const systemPrompt = [{ text: input.prompt.text }];
  const existingId = await findHarnessIdByName(input.name);
  if (existingId) {
    const existing = await control.send(new GetHarnessCommand({ harnessId: existingId }));
    const status = existing.harness?.status;
    if (status === 'READY') {
      await control.send(new UpdateHarnessCommand({
        harnessId: existingId,
        model,
        systemPrompt,
        tools: harnessTools(input.financeGatewayArn, input.webGatewayArn),
        memory: { optionalValue: { agentCoreMemoryConfiguration: {
          arn: input.memoryArn,
          messagesCount: 12,
          retrievalConfig: {
            '/users/{actorId}/facts/': {
              strategyId: input.factsStrategyId,
              topK: 5,
              relevanceScore: 0.65,
            },
            '/users/{actorId}/preferences/': {
              strategyId: input.preferencesStrategyId,
              topK: 3,
              relevanceScore: 0.65,
            },
          },
        } } },
        maxIterations: 25,
        maxTokens: 4096,
        timeoutSeconds: 300,
      }));
      const ready = await waitUntil(
        'harness',
        async () => {
          const response = await control.send(new GetHarnessCommand({ harnessId: existingId }));
          return { status: response.harness?.status, harness: response.harness };
        },
        ['READY'],
        ['CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
      );
      return { harnessId: existingId, harnessArn: ready.harness!.arn! };
    }
    if (status === 'CREATE_FAILED' || status === 'UPDATE_FAILED' || status === 'DELETE_FAILED') {
      await control.send(new DeleteHarnessCommand({ harnessId: existingId }));
      const started = Date.now();
      for (;;) {
        try {
          await control.send(new GetHarnessCommand({ harnessId: existingId }));
        } catch (error) {
          const name = error && typeof error === 'object' && 'name' in error
            ? String((error as { name: string }).name)
            : '';
          if (/ResourceNotFound|NotFound/i.test(name)) break;
          throw error;
        }
        if (Date.now() - started > 5 * 60_000) {
          throw new Error(`Timed out deleting failed harness ${existingId}`);
        }
        await sleep(5_000);
      }
    }
  }

  const created = await control.send(new CreateHarnessCommand({
    harnessName: input.name,
    executionRoleArn: input.executionRoleArn,
    model,
    systemPrompt,
    tools: harnessTools(input.financeGatewayArn, input.webGatewayArn),
    memory: { agentCoreMemoryConfiguration: {
      arn: input.memoryArn,
      messagesCount: 12,
      retrievalConfig: {
        '/users/{actorId}/facts/': {
          strategyId: input.factsStrategyId,
          topK: 5,
          relevanceScore: 0.65,
        },
        '/users/{actorId}/preferences/': {
          strategyId: input.preferencesStrategyId,
          topK: 3,
          relevanceScore: 0.65,
        },
      },
    } },
    maxIterations: 25,
    maxTokens: 4096,
    timeoutSeconds: 300,
    environment: {
      agentCoreRuntimeEnvironment: {
        networkConfiguration: { networkMode: 'PUBLIC' },
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: 900,
          maxLifetime: 3600,
        },
      },
    },
  }));
  const harnessId = created.harness?.harnessId;
  if (!harnessId) throw new Error('CreateHarness did not return harnessId.');
  const ready = await waitUntil(
    'harness',
    async () => {
      const response = await control.send(new GetHarnessCommand({ harnessId }));
      return {
        status: response.harness?.status,
        harness: response.harness,
        failureReason: (response.harness as { failureReason?: string } | undefined)?.failureReason,
      };
    },
    ['READY'],
    ['CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
  );
  if (!ready.harness?.arn) {
    throw new Error(`Harness ready without ARN${ready.failureReason ? `: ${ready.failureReason}` : ''}`);
  }
  return { harnessId, harnessArn: ready.harness.arn };
};

export const handler = async (event: ProviderEvent): Promise<{
  readonly PhysicalResourceId: string;
  readonly Data: {
    readonly HarnessArn: string;
    readonly HarnessId: string;
    readonly GatewayArn: string;
    readonly GatewayId: string;
    readonly TargetId: string;
    readonly WebSearchTargetId: string;
    readonly MemoryId: string;
  };
}> => {
  const props = event.ResourceProperties;
  const harnessName = props.HarnessName ?? 'OlbiaFinance';
  const gatewayName = props.GatewayName ?? 'OlbiaFinanceGateway';
  const financeGatewayName = props.FinanceGatewayName ?? 'OlbiaFinanceGateway';
  const targetName = props.TargetName ?? 'olbia-tools';
  const webSearchTargetName = props.WebSearchTargetName ?? 'olbia-web-search';
  const harnessRole = props.HarnessExecutionRoleArn ?? '';
  const gatewayRole = props.GatewayRoleArn ?? '';
  const toolsLambdaArn = props.ToolsLambdaArn ?? '';
  const memoryName = props.MemoryName ?? 'OlbiaFinanceMemory';
  const memoryRole = props.MemoryExecutionRoleArn ?? '';
  const memoryModelId = props.MemoryModelId ?? '';
  if (!harnessRole || !gatewayRole || !toolsLambdaArn || !memoryRole || !memoryModelId) {
    throw new Error('HarnessExecutionRoleArn, GatewayRoleArn, ToolsLambdaArn, MemoryExecutionRoleArn, and MemoryModelId are required.');
  }

  const physicalId = event.PhysicalResourceId ?? `olbia-agentcore-${harnessName}`;
  const priorResources = resourceIdsFromPhysicalId(event.PhysicalResourceId);

  if (event.RequestType === 'Delete') {
    const harnessId = priorResources.harnessId;
    if (harnessId) {
      try {
        await control.send(new DeleteHarnessCommand({ harnessId }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const started = Date.now();
      for (;;) {
        try {
          await control.send(new GetHarnessCommand({ harnessId }));
        } catch (error) {
          const name = error && typeof error === 'object' && 'name' in error
            ? String((error as { name: string }).name)
            : '';
          if (/ResourceNotFound|NotFound/i.test(name)) break;
          throw error;
        }
        if (Date.now() - started > 5 * 60_000) {
          throw new Error(`Timed out deleting harness ${harnessId}`);
        }
        await sleep(5_000);
      }
    }
    const gatewayId = priorResources.gatewayId;
    if (gatewayId) {
      for (const targetId of [priorResources.targetId, priorResources.webSearchTargetId]) {
        if (!targetId) continue;
        try {
          await control.send(new DeleteGatewayTargetCommand({
            gatewayIdentifier: gatewayId,
            targetId,
          }));
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        const started = Date.now();
        for (;;) {
          try {
            await control.send(new GetGatewayTargetCommand({
              gatewayIdentifier: gatewayId,
              targetId,
            }));
          } catch (error) {
            if (isNotFound(error)) break;
            throw error;
          }
          if (Date.now() - started > 5 * 60_000) {
            throw new Error(`Timed out deleting gateway target ${targetId}`);
          }
          await sleep(5_000);
        }
      }
      try {
        await control.send(new DeleteGatewayCommand({ gatewayIdentifier: gatewayId }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    if (priorResources.memoryId) {
      try {
        await control.send(new DeleteMemoryCommand({ memoryId: priorResources.memoryId }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return {
      PhysicalResourceId: physicalId,
      Data: {
        HarnessArn: '',
        HarnessId: '',
        GatewayArn: '',
        GatewayId: '',
        TargetId: '',
        WebSearchTargetId: '',
        MemoryId: '',
      },
    };
  }

  const prompt = await resolveRuntimePrompt();
  const webGateway = await ensureGateway({ name: gatewayName, roleArn: gatewayRole });
  const financeGateway = await resolveFinanceGateway(financeGatewayName);
  const memory = await ensureMemory({
    name: memoryName,
    executionRoleArn: memoryRole,
    modelId: memoryModelId,
    existingId: priorResources.memoryId,
  });
  const targetId = await ensureGatewayTarget({
    gatewayId: financeGateway.gatewayId,
    name: targetName,
    toolsLambdaArn,
  });
  const webSearchTargetId = await ensureWebSearchTarget({
    gatewayId: webGateway.gatewayId,
    name: webSearchTargetName,
  });
  const harness = await ensureHarness({
    name: harnessName,
    executionRoleArn: harnessRole,
    financeGatewayArn: financeGateway.gatewayArn,
    webGatewayArn: webGateway.gatewayArn,
    prompt,
    memoryArn: memory.memoryArn,
    factsStrategyId: memory.factsStrategyId,
    preferencesStrategyId: memory.preferencesStrategyId,
  });

  return {
    PhysicalResourceId: `olbia-agentcore-v3::${harness.harnessId}::${webGateway.gatewayId}::${targetId}::${webSearchTargetId}::${memory.memoryId}`,
    Data: {
      HarnessArn: harness.harnessArn,
      HarnessId: harness.harnessId,
      GatewayArn: webGateway.gatewayArn,
      GatewayId: webGateway.gatewayId,
      TargetId: targetId,
      WebSearchTargetId: webSearchTargetId,
      MemoryId: memory.memoryId,
    },
  };
};

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
  UpdateHarnessCommand,
  type ToolDefinition,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  OLBIA_SYSTEM_PROMPT_INFERENCE,
  OLBIA_SYSTEM_PROMPT_MODEL_ID,
} from './prompts/olbia-system.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

const control = new BedrockAgentCoreControlClient({});

/**
 * Placeholder only. Live system prompt + inference come from Bedrock Prompt Management
 * at InvokeHarness time (SSM-pinned version ARN). Do not bake Prompt Management content here.
 */
const HARNESS_PLACEHOLDER_SYSTEM_PROMPT =
  'Eres el asistente de Olbia. Las instrucciones operativas se inyectan en cada invocación desde Prompt Management.';

interface ProviderEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResourceProperties: {
    readonly HarnessName?: string;
    readonly GatewayName?: string;
    readonly TargetName?: string;
    readonly HarnessExecutionRoleArn?: string;
    readonly GatewayRoleArn?: string;
    readonly ToolsLambdaArn?: string;
    readonly ModelId?: string;
    readonly MemoryName?: string;
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

const findGatewayIdByName = async (name: string): Promise<string | undefined> => {
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListGatewaysCommand({ maxResults: 50, nextToken }));
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

type AgentCoreResourceIds = {
  readonly harnessId?: string;
  readonly gatewayId?: string;
  readonly targetId?: string;
  readonly memoryId?: string;
};

/**
 * V2 physical IDs own exact AgentCore resources. Legacy IDs only held a memory
 * ID, so deleting one must never fall back to a name lookup: a replacement may
 * have already created resources with the same names.
 */
const resourceIdsFromPhysicalId = (physicalId: string | undefined): AgentCoreResourceIds => {
  const parts = physicalId?.split('::') ?? [];
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

const ensureMemory = async (name: string, existingId?: string): Promise<{ memoryId: string; memoryArn: string }> => {
  if (existingId) {
    try {
      const existing = await control.send(new GetMemoryCommand({ memoryId: existingId }));
      if (existing.memory?.status === 'ACTIVE' && existing.memory.arn) {
        return { memoryId: existingId, memoryArn: existing.memory.arn };
      }
    } catch (error) {
      // A previous failed replacement can leave a Harness with a stale Memory ARN.
      // Recreate it below and repoint the existing Harness during this update.
      if (!isNotFound(error)) throw error;
    }
  }
  const created = await control.send(new CreateMemoryCommand({
    name,
    description: 'Durable, user-scoped conversational memory for the Olbia assistant.',
    // Raw events are short-lived; extracted long-term facts persist until the user deletes them.
    eventExpiryDuration: 30,
    memoryStrategies: [
      { semanticMemoryStrategy: { name: 'OlbiaFacts', namespaceTemplates: ['/users/{actorId}/facts/'] } },
      { userPreferenceMemoryStrategy: { name: 'OlbiaPreferences', namespaceTemplates: ['/users/{actorId}/preferences/'] } },
      { summaryMemoryStrategy: { name: 'OlbiaSummaries', namespaceTemplates: ['/users/{actorId}/summaries/{sessionId}/'] } },
    ],
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
  return { memoryId, memoryArn: ready.memory.arn };
};

const toolSchemaInline = (): ToolDefinition[] =>
  JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as ToolDefinition[];

const ensureGateway = async (input: {
  readonly name: string;
  readonly roleArn: string;
}): Promise<{ gatewayId: string; gatewayArn: string }> => {
  const existingId = await findGatewayIdByName(input.name);
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
    description: 'Olbia finance tools gateway for AgentCore Harness.',
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

const ensureGatewayTarget = async (input: {
  readonly gatewayId: string;
  readonly name: string;
  readonly toolsLambdaArn: string;
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
        'gateway-target',
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
    async () => control.send(new GetGatewayTargetCommand({
      gatewayIdentifier: input.gatewayId,
      targetId: created.targetId!,
    })),
    ['READY'],
    ['FAILED', 'UPDATE_UNSUCCESSFUL', 'SYNCHRONIZE_UNSUCCESSFUL'],
  );
  return created.targetId!;
};

const harnessTools = (gatewayArn: string) => ([
  {
    type: 'agentcore_gateway' as const,
    name: 'olbia-finance',
    config: {
      agentCoreGateway: {
        gatewayArn,
        outboundAuth: { awsIam: {} },
      },
    },
  },
]);

const harnessModel = (modelId: string) => ({
  bedrockModelConfig: {
    modelId,
    maxTokens: OLBIA_SYSTEM_PROMPT_INFERENCE.maxTokens,
    temperature: OLBIA_SYSTEM_PROMPT_INFERENCE.temperature,
    apiFormat: 'converse_stream' as const,
  },
});

const ensureHarness = async (input: {
  readonly name: string;
  readonly executionRoleArn: string;
  readonly gatewayArn: string;
  readonly modelId: string;
  readonly memoryArn: string;
}): Promise<{ harnessId: string; harnessArn: string }> => {
  const model = harnessModel(input.modelId);
  const systemPrompt = [{ text: HARNESS_PLACEHOLDER_SYSTEM_PROMPT }];
  const existingId = await findHarnessIdByName(input.name);
  if (existingId) {
    const existing = await control.send(new GetHarnessCommand({ harnessId: existingId }));
    const status = existing.harness?.status;
    if (status === 'READY') {
      await control.send(new UpdateHarnessCommand({
        harnessId: existingId,
        model,
        systemPrompt,
        tools: harnessTools(input.gatewayArn),
        memory: { optionalValue: { agentCoreMemoryConfiguration: { arn: input.memoryArn, messagesCount: 12 } } },
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
    tools: harnessTools(input.gatewayArn),
    memory: { agentCoreMemoryConfiguration: { arn: input.memoryArn, messagesCount: 12 } },
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
    readonly MemoryId: string;
  };
}> => {
  const props = event.ResourceProperties;
  const harnessName = props.HarnessName ?? 'OlbiaFinance';
  const gatewayName = props.GatewayName ?? 'OlbiaFinanceGateway';
  const targetName = props.TargetName ?? 'olbia-tools';
  const harnessRole = props.HarnessExecutionRoleArn ?? '';
  const gatewayRole = props.GatewayRoleArn ?? '';
  const toolsLambdaArn = props.ToolsLambdaArn ?? '';
  const modelId = props.ModelId ?? OLBIA_SYSTEM_PROMPT_MODEL_ID;
  const memoryName = props.MemoryName ?? 'OlbiaFinanceMemory';
  if (!harnessRole || !gatewayRole || !toolsLambdaArn) {
    throw new Error('HarnessExecutionRoleArn, GatewayRoleArn, and ToolsLambdaArn are required.');
  }

  const physicalId = event.PhysicalResourceId ?? `olbia-agentcore-${harnessName}`;
  const priorResources = resourceIdsFromPhysicalId(event.PhysicalResourceId);

  if (event.RequestType === 'Delete') {
    const harnessId = priorResources.harnessId;
    if (harnessId) {
      await control.send(new DeleteHarnessCommand({ harnessId }));
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
      if (priorResources.targetId) {
        await control.send(new DeleteGatewayTargetCommand({
          gatewayIdentifier: gatewayId,
          targetId: priorResources.targetId,
        }));
        const started = Date.now();
        for (;;) {
          try {
            await control.send(new GetGatewayTargetCommand({
              gatewayIdentifier: gatewayId,
              targetId: priorResources.targetId,
            }));
          } catch (error) {
            const name = error && typeof error === 'object' && 'name' in error
              ? String((error as { name: string }).name)
              : '';
            if (/ResourceNotFound|NotFound/i.test(name)) break;
            throw error;
          }
          if (Date.now() - started > 5 * 60_000) {
            throw new Error(`Timed out deleting gateway target ${priorResources.targetId}`);
          }
          await sleep(5_000);
        }
      }
      await control.send(new DeleteGatewayCommand({ gatewayIdentifier: gatewayId }));
    }
    if (priorResources.memoryId) await control.send(new DeleteMemoryCommand({ memoryId: priorResources.memoryId }));
    return {
      PhysicalResourceId: physicalId,
      Data: {
        HarnessArn: '',
        HarnessId: '',
        GatewayArn: '',
        GatewayId: '',
        TargetId: '',
        MemoryId: '',
      },
    };
  }

  const gateway = await ensureGateway({ name: gatewayName, roleArn: gatewayRole });
  const memory = await ensureMemory(memoryName, priorResources.memoryId);
  const targetId = await ensureGatewayTarget({
    gatewayId: gateway.gatewayId,
    name: targetName,
    toolsLambdaArn,
  });
  const harness = await ensureHarness({
    name: harnessName,
    executionRoleArn: harnessRole,
    gatewayArn: gateway.gatewayArn,
    modelId,
    memoryArn: memory.memoryArn,
  });

  return {
    // Updates may recover a deleted Memory while retaining the same Harness.
    // Keep the physical ID stable so CloudFormation does not issue a delete for
    // the still-live Harness, Gateway, and target after this response.
    PhysicalResourceId: event.RequestType === 'Update'
      ? physicalId
      : `olbia-agentcore-v2::${harness.harnessId}::${gateway.gatewayId}::${targetId}::${memory.memoryId}`,
    Data: {
      HarnessArn: harness.harnessArn,
      HarnessId: harness.harnessId,
      GatewayArn: gateway.gatewayArn,
      GatewayId: gateway.gatewayId,
      TargetId: targetId,
      MemoryId: memory.memoryId,
    },
  };
};

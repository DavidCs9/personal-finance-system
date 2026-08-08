import {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  CreateHarnessCommand,
  DeleteGatewayCommand,
  DeleteGatewayTargetCommand,
  DeleteHarnessCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  GetHarnessCommand,
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
  };
  readonly PhysicalResourceId?: string;
  readonly OldResourceProperties?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <T extends { status?: string }>(
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
      throw new Error(`${label} entered terminal status ${status}`);
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
    topP: OLBIA_SYSTEM_PROMPT_INFERENCE.topP,
    apiFormat: 'converse_stream' as const,
  },
});

const ensureHarness = async (input: {
  readonly name: string;
  readonly executionRoleArn: string;
  readonly gatewayArn: string;
  readonly modelId: string;
}): Promise<{ harnessId: string; harnessArn: string }> => {
  const model = harnessModel(input.modelId);
  const systemPrompt = [{ text: HARNESS_PLACEHOLDER_SYSTEM_PROMPT }];
  const existingId = await findHarnessIdByName(input.name);
  if (existingId) {
    await control.send(new UpdateHarnessCommand({
      harnessId: existingId,
      model,
      systemPrompt,
      tools: harnessTools(input.gatewayArn),
      memory: { optionalValue: { disabled: {} } },
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

  const created = await control.send(new CreateHarnessCommand({
    harnessName: input.name,
    executionRoleArn: input.executionRoleArn,
    model,
    systemPrompt,
    tools: harnessTools(input.gatewayArn),
    memory: { disabled: {} },
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
      return { status: response.harness?.status, harness: response.harness };
    },
    ['READY'],
    ['CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
  );
  return { harnessId, harnessArn: ready.harness!.arn! };
};

export const handler = async (event: ProviderEvent): Promise<{
  readonly PhysicalResourceId: string;
  readonly Data: {
    readonly HarnessArn: string;
    readonly HarnessId: string;
    readonly GatewayArn: string;
    readonly GatewayId: string;
    readonly TargetId: string;
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
  if (!harnessRole || !gatewayRole || !toolsLambdaArn) {
    throw new Error('HarnessExecutionRoleArn, GatewayRoleArn, and ToolsLambdaArn are required.');
  }

  const physicalId = event.PhysicalResourceId ?? `olbia-agentcore-${harnessName}`;

  if (event.RequestType === 'Delete') {
    const harnessId = await findHarnessIdByName(harnessName);
    if (harnessId) {
      await control.send(new DeleteHarnessCommand({ harnessId }));
    }
    const gatewayId = await findGatewayIdByName(gatewayName);
    if (gatewayId) {
      let nextToken: string | undefined;
      do {
        const page = await control.send(new ListGatewayTargetsCommand({
          gatewayIdentifier: gatewayId,
          maxResults: 50,
          nextToken,
        }));
        for (const item of page.items ?? []) {
          if (item.targetId) {
            await control.send(new DeleteGatewayTargetCommand({
              gatewayIdentifier: gatewayId,
              targetId: item.targetId,
            }));
          }
        }
        nextToken = page.nextToken;
      } while (nextToken);
      await control.send(new DeleteGatewayCommand({ gatewayIdentifier: gatewayId }));
    }
    return {
      PhysicalResourceId: physicalId,
      Data: {
        HarnessArn: '',
        HarnessId: '',
        GatewayArn: '',
        GatewayId: '',
        TargetId: '',
      },
    };
  }

  const gateway = await ensureGateway({ name: gatewayName, roleArn: gatewayRole });
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
  });

  return {
    PhysicalResourceId: physicalId,
    Data: {
      HarnessArn: harness.harnessArn,
      HarnessId: harness.harnessId,
      GatewayArn: gateway.gatewayArn,
      GatewayId: gateway.gatewayId,
      TargetId: targetId,
    },
  };
};

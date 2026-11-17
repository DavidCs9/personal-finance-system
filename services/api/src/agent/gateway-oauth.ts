import {
  BedrockAgentCoreControlClient, GetGatewayCommand, GetGatewayTargetCommand,
  CreateGatewayCommand, CreateGatewayTargetCommand, UpdateGatewayTargetCommand,
  DeleteGatewayCommand, DeleteGatewayTargetCommand, ListTagsForResourceCommand,
  UpdateGatewayCommand, paginateListGateways, paginateListGatewayTargets,
  type GetGatewayResponse, type UpdateGatewayCommandInput, type AuthorizerConfiguration, type ToolDefinition,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

const client = new BedrockAgentCoreControlClient({ region: process.env.AWS_REGION });

export interface FinanceMcpOAuthProperties {
  GatewayName: string;
  ToolsLambdaArn: string;
  DiscoveryUrl: string;
  ClientId: string;
  OwnerSub: string;
  ReadScope: string;
  GatewayRoleArn: string;
  StackId: string;
}

const ownershipTags = (props: FinanceMcpOAuthProperties) => ({
  OlbiaIntegration: 'chatgpt-read-only', CloudFormationStackId: props.StackId,
});

export const financeMcpOAuthAuthorizer = (
  resource: string, props: FinanceMcpOAuthProperties,
): AuthorizerConfiguration => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.OwnerSub)
    || !props.ClientId?.trim() || props.ReadScope !== 'olbia-finance/read'
    || props.GatewayName !== 'OlbiaChatGptFinance' || !props.GatewayRoleArn?.trim()
    || !/^arn:aws:cloudformation:[\w-]+:\d{12}:stack\//.test(props.StackId)) {
    throw new Error('Finance OAuth requires the configured owner, client and read scope.');
  }
  const discovery = new URL(props.DiscoveryUrl);
  const audience = new URL(resource);
  if (discovery.protocol !== 'https:' || discovery.username || discovery.password || discovery.search || discovery.hash
    || !discovery.pathname.endsWith('/.well-known/openid-configuration')
    || audience.protocol !== 'https:' || audience.pathname !== '/mcp') {
    throw new Error('Finance OAuth requires HTTPS discovery and the native MCP resource.');
  }
  return { customJWTAuthorizer: {
    discoveryUrl: props.DiscoveryUrl,
    allowedClients: [props.ClientId], allowedAudience: [resource], allowedScopes: [props.ReadScope],
    customClaims: [ ['sub', props.OwnerSub], ['token_use', 'access'] ].map(([name, value]) => ({
      inboundTokenClaimName: name, inboundTokenClaimValueType: 'STRING',
      authorizingClaimMatchValue: { claimMatchOperator: 'EQUALS', claimMatchValue: { matchValueString: value! } },
    })),
  } };
};

/** Only update JWT configuration; AWS makes the authorizer type immutable. */
export const financeMcpOAuthUpdate = (
  gateway: GetGatewayResponse, props: FinanceMcpOAuthProperties,
): UpdateGatewayCommandInput => {
  if (!gateway.gatewayId || !gateway.gatewayUrl || gateway.roleArn !== props.GatewayRoleArn
    || gateway.name !== props.GatewayName || gateway.protocolType !== 'MCP' || gateway.authorizerType !== 'CUSTOM_JWT') {
    throw new Error('Unexpected OAuth Gateway configuration; authentication type cannot be changed.');
  }
  return {
    gatewayIdentifier: gateway.gatewayId, name: gateway.name, roleArn: gateway.roleArn,
    description: gateway.description, protocolType: 'MCP', protocolConfiguration: gateway.protocolConfiguration,
    kmsKeyArn: gateway.kmsKeyArn, customTransformConfiguration: gateway.customTransformConfiguration,
    interceptorConfigurations: gateway.interceptorConfigurations,
    policyEngineConfiguration: gateway.policyEngineConfiguration, exceptionLevel: gateway.exceptionLevel,
    wafConfiguration: gateway.wafConfiguration,
    authorizerType: 'CUSTOM_JWT',
    authorizerConfiguration: financeMcpOAuthAuthorizer(gateway.gatewayUrl, props),
  };
};

const waitReady = async (gatewayId: string): Promise<GetGatewayResponse> => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const gateway = await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    if (gateway.status === 'READY') return gateway;
    if (['FAILED', 'UPDATE_UNSUCCESSFUL', 'DELETING'].includes(gateway.status ?? '')) {
      throw new Error(`Finance Gateway ${gateway.status}: ${(gateway.statusReasons ?? []).join('; ').slice(0, 512) || 'no reason returned'}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('Finance Gateway update timed out.');
};

const waitTargetReady = async (gatewayId: string, targetId: string) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const target = await client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId }));
    if (target.status === 'READY') return;
    if (['FAILED', 'UPDATE_UNSUCCESSFUL', 'DELETING'].includes(target.status ?? '')) {
      throw new Error(`Finance read target ${target.status}: ${(target.statusReasons ?? []).join('; ').slice(0, 512) || 'no reason returned'}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('Finance read target timed out.');
};

const authorizerMatches = (gateway: GetGatewayResponse, expected: AuthorizerConfiguration | undefined) => {
  const actual = gateway.authorizerConfiguration?.customJWTAuthorizer;
  const wanted = expected?.customJWTAuthorizer;
  return gateway.authorizerType === 'CUSTOM_JWT' && !!actual && !!wanted
    && actual.discoveryUrl === wanted.discoveryUrl
    && isDeepStrictEqual(actual.allowedAudience, wanted.allowedAudience)
    && isDeepStrictEqual(actual.allowedClients, wanted.allowedClients)
    && isDeepStrictEqual(actual.allowedScopes, wanted.allowedScopes)
    && wanted.customClaims?.every(claim => actual.customClaims?.some(candidate => isDeepStrictEqual(claim, candidate)));
};

const waitRemoved = async (read: () => Promise<unknown>) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await read(); } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('OAuth Gateway removal timed out.');
};

export const handler = async (event: {
  RequestType: 'Create' | 'Update' | 'Delete'; ResourceProperties: FinanceMcpOAuthProperties;
  PhysicalResourceId?: string;
}) => {
  const props = event.ResourceProperties;
  // No tools are attached until this bootstrap audience is replaced with the
  // real endpoint and every required authorization constraint is read back.
  if (props.GatewayName !== 'OlbiaChatGptFinance'
    || !/^arn:aws:cloudformation:[\w-]+:\d{12}:stack\//.test(props.StackId)) {
    throw new Error('Unexpected OAuth integration identity.');
  }
  const bootstrapAuth = event.RequestType === 'Delete' ? undefined
    : financeMcpOAuthAuthorizer('https://unconfigured.invalid/mcp', props);
  let gatewayId: string | undefined;
  for await (const page of paginateListGateways({ client }, {})) {
    const match = page.items?.find(g => g.name === props.GatewayName);
    if (match) { gatewayId = match.gatewayId; break; }
  }
  if (!gatewayId && event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? 'olbia-chatgpt-mcp::removed', Data: {} };
  }
  if (!gatewayId) {
    const created = await client.send(new CreateGatewayCommand({
      name: props.GatewayName, roleArn: props.GatewayRoleArn, protocolType: 'MCP',
      description: 'Read-only ChatGPT access to the existing Olbia finance tools.',
      authorizerType: 'CUSTOM_JWT', authorizerConfiguration: bootstrapAuth, tags: ownershipTags(props),
      clientToken: createHash('sha256').update(`${props.StackId}:${props.GatewayName}:${props.ClientId}`).digest('hex'),
    }));
    gatewayId = created.gatewayId;
    if (!gatewayId) throw new Error('OAuth Gateway creation returned no identity.');
  }
  let gateway = event.RequestType === 'Delete'
    ? await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }))
    : await waitReady(gatewayId);
  if (!gateway.gatewayArn) throw new Error('OAuth Gateway has no ARN.');
  const tags = await client.send(new ListTagsForResourceCommand({ resourceArn: gateway.gatewayArn }));
  if (Object.entries(ownershipTags(props)).some(([key, value]) => tags.tags?.[key] !== value)) {
    throw new Error('OAuth Gateway does not belong to this CloudFormation integration.');
  }
  const targets = [];
  for await (const page of paginateListGatewayTargets({ client }, { gatewayIdentifier: gatewayId })) {
    targets.push(...(page.items ?? []));
  }
  if (targets.length > 1 || targets.some(t => t.name !== 'olbia-tools' || !t.targetId)) {
    throw new Error('OAuth can expose only the existing read-only finance target.');
  }
  if (event.RequestType === 'Delete') {
    // This resource owns only its new ingress. Never delete the shared Lambda,
    // legacy IAM Gateway, conversations, originals or financial data.
    for (const target of targets) {
      await client.send(new DeleteGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId: target.targetId! }));
      await waitRemoved(() => client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId: target.targetId! })));
    }
    await client.send(new DeleteGatewayCommand({ gatewayIdentifier: gatewayId }));
    await waitRemoved(() => client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId })));
  } else {
    if (targets[0]?.targetId) {
      const existing = await client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId: targets[0].targetId }));
      const lambda = existing.targetConfiguration?.mcp?.lambda;
      const allowedNames = new Set<string>(TOOL_DEFINITIONS.map(t => t.name));
      if (lambda?.lambdaArn !== props.ToolsLambdaArn || lambda.toolSchema?.inlinePayload?.some(t => !allowedNames.has(t.name!))) {
        throw new Error('OAuth target differs from the existing read-only Lambda/catalog.');
      }
    }
    const update = financeMcpOAuthUpdate(gateway, props);
    if (!authorizerMatches(gateway, update.authorizerConfiguration)) {
      await client.send(new UpdateGatewayCommand(update));
      gateway = await waitReady(gatewayId);
    }
    if (!authorizerMatches(gateway, update.authorizerConfiguration)) {
      throw new Error('OAuth authorization constraints were not applied.');
    }
    const targetConfig = { mcp: { lambda: { lambdaArn: props.ToolsLambdaArn,
      toolSchema: { inlinePayload: JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as ToolDefinition[] } } } };
    const targetInput = { gatewayIdentifier: gatewayId, name: 'olbia-tools', targetConfiguration: targetConfig,
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' as const }] };
    if (targets[0]?.targetId) {
      await client.send(new UpdateGatewayTargetCommand({ ...targetInput, targetId: targets[0].targetId }));
      await waitTargetReady(gatewayId, targets[0].targetId);
    } else {
      const target = await client.send(new CreateGatewayTargetCommand(targetInput));
      if (!target.targetId) throw new Error('Finance read target creation returned no identity.');
      await waitTargetReady(gatewayId, target.targetId);
    }
  }
  return { PhysicalResourceId: event.PhysicalResourceId ?? `olbia-chatgpt-mcp::${gatewayId}`,
    Data: { GatewayUrl: gateway.gatewayUrl!, GatewayArn: gateway.gatewayArn! } };
};

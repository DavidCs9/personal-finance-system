import {
  BedrockAgentCoreControlClient, GetGatewayCommand, GetGatewayTargetCommand,
  UpdateGatewayCommand, paginateListGateways, paginateListGatewayTargets,
  type GetGatewayResponse, type UpdateGatewayCommandInput,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { isDeepStrictEqual } from 'node:util';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

const client = new BedrockAgentCoreControlClient({ region: process.env.AWS_REGION });

export interface FinanceMcpOAuthProperties {
  GatewayName: string;
  ToolsLambdaArn: string;
  DiscoveryUrl: string;
  ClientId: string;
  OwnerSub: string;
  ReadScope: string;
}

/** Preserve the existing Gateway, targets, encryption, protocol and policy configuration. */
export const financeMcpOAuthUpdate = (
  gateway: GetGatewayResponse, props: FinanceMcpOAuthProperties,
): UpdateGatewayCommandInput => {
  if (!gateway.gatewayId || !gateway.gatewayUrl || !gateway.roleArn || gateway.name !== props.GatewayName
    || gateway.protocolType !== 'MCP') throw new Error('Unexpected finance Gateway configuration.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.OwnerSub)
    || !props.ClientId?.trim() || props.ReadScope !== 'olbia-finance/read') {
    throw new Error('Finance OAuth requires the configured owner, client and read scope.');
  }
  const discovery = new URL(props.DiscoveryUrl);
  const audience = new URL(gateway.gatewayUrl);
  if (discovery.protocol !== 'https:' || discovery.username || discovery.password || discovery.search || discovery.hash
    || !discovery.pathname.endsWith('/.well-known/openid-configuration')
    || audience.protocol !== 'https:' || audience.pathname !== '/mcp') {
    throw new Error('Finance OAuth requires HTTPS discovery and the native MCP resource.');
  }
  return {
    gatewayIdentifier: gateway.gatewayId, name: gateway.name, roleArn: gateway.roleArn,
    description: gateway.description, protocolType: 'MCP', protocolConfiguration: gateway.protocolConfiguration,
    kmsKeyArn: gateway.kmsKeyArn, customTransformConfiguration: gateway.customTransformConfiguration,
    interceptorConfigurations: gateway.interceptorConfigurations,
    policyEngineConfiguration: gateway.policyEngineConfiguration, exceptionLevel: gateway.exceptionLevel,
    wafConfiguration: gateway.wafConfiguration,
    authorizerType: 'CUSTOM_JWT',
    authorizerConfiguration: { customJWTAuthorizer: {
      discoveryUrl: props.DiscoveryUrl,
      allowedClients: [props.ClientId], allowedAudience: [gateway.gatewayUrl], allowedScopes: [props.ReadScope],
      customClaims: [ ['sub', props.OwnerSub], ['token_use', 'access'] ].map(([name, value]) => ({
        inboundTokenClaimName: name, inboundTokenClaimValueType: 'STRING',
        authorizingClaimMatchValue: { claimMatchOperator: 'EQUALS', claimMatchValue: { matchValueString: value! } },
      })),
    } },
  };
};

const waitReady = async (gatewayId: string): Promise<GetGatewayResponse> => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const gateway = await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    if (gateway.status === 'READY') return gateway;
    if (['FAILED', 'UPDATE_UNSUCCESSFUL', 'DELETING'].includes(gateway.status ?? '')) {
      throw new Error('Finance Gateway did not become ready.');
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('Finance Gateway update timed out.');
};

export const handler = async (event: {
  RequestType: 'Create' | 'Update' | 'Delete'; ResourceProperties: FinanceMcpOAuthProperties;
  PhysicalResourceId?: string;
}) => {
  const props = event.ResourceProperties;
  let gatewayId: string | undefined;
  for await (const page of paginateListGateways({ client }, {})) {
    const match = page.items?.find(g => g.name === props.GatewayName);
    if (match) { gatewayId = match.gatewayId; break; }
  }
  if (!gatewayId) throw new Error('Existing finance Gateway was not found.');
  let gateway = event.RequestType === 'Delete'
    ? await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }))
    : await waitReady(gatewayId);
  const update = financeMcpOAuthUpdate(gateway, props);
  if (event.RequestType === 'Delete') {
    // CloudFormation rollback/removal restores the pre-existing IAM boundary,
    // but never overwrites auth configured by a different OAuth integration.
    if (gateway.authorizerType === 'CUSTOM_JWT'
      && isDeepStrictEqual(gateway.authorizerConfiguration, update.authorizerConfiguration)) {
      await client.send(new UpdateGatewayCommand({ ...update, authorizerType: 'AWS_IAM', authorizerConfiguration: undefined }));
      gateway = await waitReady(gatewayId);
    }
  } else {
    const targets = [];
    for await (const page of paginateListGatewayTargets({ client }, { gatewayIdentifier: gatewayId })) {
      targets.push(...(page.items ?? []));
    }
    if (targets.length !== 1 || targets[0]?.name !== 'olbia-tools' || !targets[0].targetId) {
      throw new Error('OAuth can expose only the existing read-only finance target.');
    }
    const target = await client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gatewayId, targetId: targets[0].targetId }));
    const lambda = target.targetConfiguration?.mcp?.lambda;
    const names = lambda?.toolSchema?.inlinePayload?.map(t => t.name).sort();
    if (lambda?.lambdaArn !== props.ToolsLambdaArn || !isDeepStrictEqual(names, TOOL_DEFINITIONS.map(t => t.name).sort())) {
      throw new Error('Finance Gateway tools differ from the reviewed read-only catalog.');
    }
    if (gateway.authorizerType !== update.authorizerType
      || !isDeepStrictEqual(gateway.authorizerConfiguration, update.authorizerConfiguration)) {
      await client.send(new UpdateGatewayCommand(update));
      gateway = await waitReady(gatewayId);
    }
  }
  return { PhysicalResourceId: event.PhysicalResourceId ?? `olbia-finance-oauth::${gatewayId}`,
    Data: { GatewayUrl: gateway.gatewayUrl!, GatewayArn: gateway.gatewayArn! } };
};

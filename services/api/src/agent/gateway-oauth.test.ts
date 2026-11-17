import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetGatewayResponse } from '@aws-sdk/client-bedrock-agentcore-control';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

const mocks = vi.hoisted(() => ({ send: vi.fn(), targets: [] as { name: string; targetId: string }[] }));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-agentcore-control')>();
  return { ...actual,
    BedrockAgentCoreControlClient: class { send = mocks.send; },
    paginateListGateways: async function* () { yield { items: [{ name: 'OlbiaFinanceGateway', gatewayId: 'finance' }] }; },
    paginateListGatewayTargets: async function* () { yield { items: mocks.targets }; },
  };
});
import { financeMcpOAuthUpdate, handler, type FinanceMcpOAuthProperties } from './gateway-oauth.js';

const props: FinanceMcpOAuthProperties = {
  GatewayName: 'OlbiaFinanceGateway', ToolsLambdaArn: 'arn:aws:lambda:us-east-2:123456789012:function:read-tools',
  DiscoveryUrl: 'https://cognito-idp.us-east-2.amazonaws.com/pool/.well-known/openid-configuration',
  ClientId: 'chatgpt-client', OwnerSub: '11111111-2222-3333-4444-555555555555', ReadScope: 'olbia-finance/read',
};
const initial = (): GetGatewayResponse => ({
  gatewayId: 'finance', gatewayArn: 'arn:aws:bedrock-agentcore:us-east-2:123456789012:gateway/finance',
  name: props.GatewayName, gatewayUrl: 'https://finance.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp',
  roleArn: 'arn:aws:iam::123456789012:role/gateway', status: 'READY', protocolType: 'MCP', authorizerType: 'AWS_IAM',
  createdAt: new Date(0), updatedAt: new Date(0),
  kmsKeyArn: 'retained-key', protocolConfiguration: { mcp: { instructions: 'Existing server guidance' } },
});
let gateway: GetGatewayResponse;
let toolsArn: string;

beforeEach(() => {
  vi.clearAllMocks();
  gateway = initial();
  toolsArn = props.ToolsLambdaArn;
  mocks.targets = [{ name: 'olbia-tools', targetId: 'read' }];
  mocks.send.mockImplementation(async command => {
    switch (command.constructor.name) {
      case 'GetGatewayCommand': return gateway;
      case 'GetGatewayTargetCommand': return { targetConfiguration: { mcp: { lambda: {
        lambdaArn: toolsArn, toolSchema: { inlinePayload: TOOL_DEFINITIONS },
      } } } };
      case 'UpdateGatewayCommand':
        gateway = { ...gateway, ...command.input };
        return gateway;
      default: throw new Error('Unexpected control-plane operation');
    }
  });
});

describe('existing finance Gateway OAuth boundary', () => {
  it('requires the exact owner, access-token use, MCP audience, client and read scope while retaining native configuration', () => {
    const update = financeMcpOAuthUpdate(gateway, props);
    expect(update).toMatchObject({
      gatewayIdentifier: 'finance', roleArn: gateway.roleArn, kmsKeyArn: 'retained-key',
      protocolConfiguration: gateway.protocolConfiguration, authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: { customJWTAuthorizer: {
        allowedAudience: [gateway.gatewayUrl], allowedClients: [props.ClientId], allowedScopes: [props.ReadScope],
        customClaims: [
          { inboundTokenClaimName: 'sub', inboundTokenClaimValueType: 'STRING',
            authorizingClaimMatchValue: { claimMatchOperator: 'EQUALS', claimMatchValue: { matchValueString: props.OwnerSub } } },
          { inboundTokenClaimName: 'token_use', inboundTokenClaimValueType: 'STRING',
            authorizingClaimMatchValue: { claimMatchOperator: 'EQUALS', claimMatchValue: { matchValueString: 'access' } } },
        ],
      } },
    });
  });

  it.each([{ ...props, OwnerSub: '' }, { ...props, ClientId: '' }, { ...props, ReadScope: 'write' },
    { ...props, DiscoveryUrl: 'http://issuer/.well-known/openid-configuration' }])('fails closed for invalid OAuth configuration', async invalid => {
    await expect(handler({ RequestType: 'Create', ResourceProperties: invalid })).rejects.toThrow();
    expect(mocks.send.mock.calls.some(([c]) => c.constructor.name === 'UpdateGatewayCommand')).toBe(false);
  });

  it('adapts the same Gateway without creating a Gateway, tool target, model or financial invocation', async () => {
    const result = await handler({ RequestType: 'Create', ResourceProperties: props });
    expect(result.Data.GatewayUrl).toBe(gateway.gatewayUrl);
    expect(mocks.send.mock.calls.map(([c]) => c.constructor.name)).toEqual([
      'GetGatewayCommand', 'GetGatewayTargetCommand', 'UpdateGatewayCommand', 'GetGatewayCommand',
    ]);
  });

  it('rejects an additional target rather than exposing mutation tools under the read scope', async () => {
    mocks.targets.push({ name: 'olbia-tag-mutations', targetId: 'writes' });
    await expect(handler({ RequestType: 'Create', ResourceProperties: props })).rejects.toThrow('read-only');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a replaced tools Lambda before enabling OAuth', async () => {
    toolsArn = 'arn:aws:lambda:us-east-2:123456789012:function:other';
    await expect(handler({ RequestType: 'Update', ResourceProperties: props })).rejects.toThrow('reviewed');
    expect(mocks.send.mock.calls.some(([c]) => c.constructor.name === 'UpdateGatewayCommand')).toBe(false);
  });

  it('does not reconfigure an already matching authorizer', async () => {
    gateway = { ...gateway, ...financeMcpOAuthUpdate(gateway, props) };
    await handler({ RequestType: 'Update', ResourceProperties: props });
    expect(mocks.send.mock.calls.map(([c]) => c.constructor.name)).toEqual(['GetGatewayCommand', 'GetGatewayTargetCommand']);
  });

  it('restores IAM on CloudFormation removal without deleting the existing Gateway or memory', async () => {
    gateway = { ...gateway, ...financeMcpOAuthUpdate(gateway, props) };
    await handler({ RequestType: 'Delete', ResourceProperties: props });
    expect(gateway.authorizerType).toBe('AWS_IAM');
    expect(gateway.authorizerConfiguration).toBeUndefined();
    expect(mocks.send.mock.calls.map(([c]) => c.constructor.name)).toEqual(['GetGatewayCommand', 'UpdateGatewayCommand', 'GetGatewayCommand']);
  });

  it('does not overwrite a different integration during rollback', async () => {
    gateway = { ...gateway, ...financeMcpOAuthUpdate(gateway, { ...props, ClientId: 'different-client' }) };
    await handler({ RequestType: 'Delete', ResourceProperties: props });
    expect(gateway.authorizerConfiguration?.customJWTAuthorizer?.allowedClients).toEqual(['different-client']);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('can restore IAM even when the preceding OAuth update reported failure', async () => {
    gateway = { ...gateway, ...financeMcpOAuthUpdate(gateway, props), status: 'UPDATE_UNSUCCESSFUL' };
    mocks.send.mockImplementationOnce(async () => gateway);
    mocks.send.mockImplementationOnce(async command => {
      gateway = { ...gateway, ...command.input, status: 'READY' };
      return gateway;
    });
    await handler({ RequestType: 'Delete', ResourceProperties: props });
    expect(gateway.authorizerType).toBe('AWS_IAM');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetGatewayResponse } from '@aws-sdk/client-bedrock-agentcore-control';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

const mocks = vi.hoisted(() => ({ send: vi.fn(), listed: true, tagOwner: '', ignoreScope: false,
  targets: [] as { name: string; targetId: string }[] }));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-agentcore-control')>();
  return { ...actual,
    BedrockAgentCoreControlClient: class { send = mocks.send; },
    paginateListGateways: async function* () { yield { items: mocks.listed ? [{ name: 'OlbiaChatGptFinance', gatewayId: 'finance' }] : [] }; },
    paginateListGatewayTargets: async function* () { yield { items: [...mocks.targets] }; },
  };
});
import { financeMcpOAuthUpdate, handler, type FinanceMcpOAuthProperties } from './gateway-oauth.js';

const props: FinanceMcpOAuthProperties = {
  GatewayName: 'OlbiaChatGptFinance', ToolsLambdaArn: 'arn:aws:lambda:us-east-2:123456789012:function:read-tools',
  DiscoveryUrl: 'https://cognito-idp.us-east-2.amazonaws.com/pool/.well-known/openid-configuration',
  ClientId: 'chatgpt-client', OwnerSub: '11111111-2222-3333-4444-555555555555', ReadScope: 'olbia-finance/read',
  GatewayRoleArn: 'arn:aws:iam::123456789012:role/gateway',
  StackId: 'arn:aws:cloudformation:us-east-2:123456789012:stack/Olbia/id',
};
const initial = (): GetGatewayResponse => ({
  gatewayId: 'finance', gatewayArn: 'arn:aws:bedrock-agentcore:us-east-2:123456789012:gateway/finance',
  name: props.GatewayName, gatewayUrl: 'https://finance.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp',
  roleArn: props.GatewayRoleArn, status: 'READY', protocolType: 'MCP', authorizerType: 'CUSTOM_JWT',
  createdAt: new Date(0), updatedAt: new Date(0), kmsKeyArn: 'retained-key',
  protocolConfiguration: { mcp: { instructions: 'Existing server guidance' } },
});
let gateway: GetGatewayResponse;
let toolsArn: string;
const missing = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
const commands = () => mocks.send.mock.calls.map(([c]) => c.constructor.name);

beforeEach(() => {
  vi.clearAllMocks();
  gateway = initial(); toolsArn = props.ToolsLambdaArn;
  mocks.listed = true; mocks.tagOwner = props.StackId; mocks.ignoreScope = false;
  mocks.targets = [{ name: 'olbia-tools', targetId: 'read' }];
  mocks.send.mockImplementation(async command => {
    switch (command.constructor.name) {
      case 'CreateGatewayCommand':
        gateway = { ...gateway, ...command.input, status: 'READY' }; mocks.listed = true; return gateway;
      case 'GetGatewayCommand':
        if (!mocks.listed) throw missing();
        return gateway;
      case 'ListTagsForResourceCommand': return { tags: { OlbiaIntegration: 'chatgpt-read-only', CloudFormationStackId: mocks.tagOwner } };
      case 'GetGatewayTargetCommand':
        if (!mocks.targets.length) throw missing();
        return { status: 'READY', targetConfiguration: { mcp: { lambda: {
          lambdaArn: toolsArn, toolSchema: { inlinePayload: TOOL_DEFINITIONS },
        } } } };
      case 'UpdateGatewayCommand':
        if (command.input.authorizerType !== gateway.authorizerType) throw new Error('Authorizer type cannot be updated');
        gateway = { ...gateway, ...structuredClone(command.input) };
        if (mocks.ignoreScope) delete gateway.authorizerConfiguration!.customJWTAuthorizer!.allowedScopes;
        return gateway;
      case 'CreateGatewayTargetCommand': mocks.targets.push({ name: 'olbia-tools', targetId: 'read' }); return { targetId: 'read' };
      case 'UpdateGatewayTargetCommand': return { targetId: 'read' };
      case 'DeleteGatewayTargetCommand': mocks.targets = []; return {};
      case 'DeleteGatewayCommand': mocks.listed = false; return {};
      default: throw new Error('Unexpected control-plane operation');
    }
  });
});

describe('native ChatGPT Gateway reusing the finance read implementation', () => {
  it('requires the exact owner, access-token use, audience, client and read scope while retaining Gateway configuration', () => {
    expect(financeMcpOAuthUpdate(gateway, props)).toMatchObject({
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
    { ...props, GatewayName: 'OlbiaFinanceGateway' },
    { ...props, DiscoveryUrl: 'http://issuer/.well-known/openid-configuration' }])('fails closed before any API mutation for invalid configuration', async invalid => {
    await expect(handler({ RequestType: 'Create', ResourceProperties: invalid })).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('creates JWT from the start and binds the final audience before attaching the existing read Lambda', async () => {
    mocks.listed = false; mocks.targets = [];
    const result = await handler({ RequestType: 'Create', ResourceProperties: props });
    expect(result.Data.GatewayUrl).toBe(gateway.gatewayUrl);
    expect(commands()).toEqual(['CreateGatewayCommand', 'GetGatewayCommand', 'ListTagsForResourceCommand',
      'UpdateGatewayCommand', 'GetGatewayCommand', 'CreateGatewayTargetCommand', 'GetGatewayTargetCommand']);
    const create = mocks.send.mock.calls[0]![0].input;
    expect(create.authorizerType).toBe('CUSTOM_JWT');
    expect(create.authorizerConfiguration.customJWTAuthorizer.allowedAudience).toEqual(['https://unconfigured.invalid/mcp']);
    const target = mocks.send.mock.calls.find(([c]) => c.constructor.name === 'CreateGatewayTargetCommand')![0].input;
    expect(target.targetConfiguration.mcp.lambda.lambdaArn).toBe(props.ToolsLambdaArn);
    expect(target.targetConfiguration.mcp.lambda.toolSchema.inlinePayload.map((t: { name: string }) => t.name)).toEqual(TOOL_DEFINITIONS.map(t => t.name));
  });

  it('never attempts to change an existing IAM Gateway to JWT', async () => {
    gateway.authorizerType = 'AWS_IAM';
    await expect(handler({ RequestType: 'Update', ResourceProperties: props })).rejects.toThrow('cannot be changed');
    expect(commands()).not.toContain('UpdateGatewayCommand');
  });

  it('does not attach tools if the service fails to retain a required authorization constraint', async () => {
    mocks.listed = false; mocks.targets = []; mocks.ignoreScope = true;
    await expect(handler({ RequestType: 'Create', ResourceProperties: props })).rejects.toThrow('constraints were not applied');
    expect(commands()).not.toContain('CreateGatewayTargetCommand');
  });

  it('rejects another stack ownership before any mutation', async () => {
    mocks.tagOwner = 'different-stack';
    await expect(handler({ RequestType: 'Delete', ResourceProperties: props })).rejects.toThrow('does not belong');
    expect(commands()).toEqual(['GetGatewayCommand', 'ListTagsForResourceCommand']);
  });

  it('rejects mutation targets before enabling finance access', async () => {
    mocks.targets.push({ name: 'olbia-tag-mutations', targetId: 'writes' });
    await expect(handler({ RequestType: 'Update', ResourceProperties: props })).rejects.toThrow('read-only');
    expect(commands()).not.toContain('UpdateGatewayCommand');
  });

  it('rejects a replaced read Lambda before enabling finance access', async () => {
    toolsArn = 'arn:aws:lambda:us-east-2:123456789012:function:other';
    await expect(handler({ RequestType: 'Update', ResourceProperties: props })).rejects.toThrow('read-only');
    expect(commands()).not.toContain('UpdateGatewayCommand');
  });

  it('keeps an already matching authorizer and reconciles only the read catalog', async () => {
    gateway = { ...gateway, ...financeMcpOAuthUpdate(gateway, props) };
    await handler({ RequestType: 'Update', ResourceProperties: props });
    expect(commands()).not.toContain('UpdateGatewayCommand');
    expect(commands()).toContain('UpdateGatewayTargetCommand');
  });

  it('deletes only the owned OAuth target and ingress, with no legacy Gateway, Lambda or memory operation', async () => {
    await handler({ RequestType: 'Delete', ResourceProperties: props });
    expect(commands()).toEqual(['GetGatewayCommand', 'ListTagsForResourceCommand',
      'DeleteGatewayTargetCommand', 'GetGatewayTargetCommand', 'DeleteGatewayCommand', 'GetGatewayCommand']);
    expect(mocks.listed).toBe(false);
  });

  it('handles rollback before Gateway creation without creating infrastructure', async () => {
    mocks.listed = false;
    await handler({ RequestType: 'Delete', ResourceProperties: props });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rolls back invalid OAuth settings without requiring the failed settings to validate again', async () => {
    mocks.listed = false;
    await handler({ RequestType: 'Delete', ResourceProperties: { ...props, OwnerSub: '' } });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('can remove its failed bootstrap Gateway without requiring a live endpoint', async () => {
    gateway = { ...gateway, status: 'FAILED', gatewayUrl: undefined };
    mocks.targets = [];
    await handler({ RequestType: 'Delete', ResourceProperties: props });
    expect(commands()).toContain('DeleteGatewayCommand');
  });

  it('reports the native readiness failure reason without dumping request configuration', async () => {
    gateway = { ...gateway, status: 'FAILED', statusReasons: ['Missing workload identity permission'] };
    await expect(handler({ RequestType: 'Update', ResourceProperties: props })).rejects.toThrow('Missing workload identity permission');
    expect(commands()).toEqual(['GetGatewayCommand', 'ListTagsForResourceCommand', 'GetGatewayCommand']);
    expect(commands()).not.toContain('DeleteGatewayCommand');
  });

  it('recovers only an owned failed bootstrap without attached tools', async () => {
    gateway.status = 'FAILED'; mocks.targets = [];
    await handler({ RequestType: 'Create', ResourceProperties: props });
    const calls = commands();
    expect(calls.indexOf('DeleteGatewayCommand')).toBeLessThan(calls.indexOf('CreateGatewayCommand'));
    expect(calls.indexOf('UpdateGatewayCommand')).toBeLessThan(calls.indexOf('CreateGatewayTargetCommand'));
    expect(gateway.authorizerConfiguration?.customJWTAuthorizer?.allowedAudience).toEqual([gateway.gatewayUrl]);
  });

  it('does not recover a failed bootstrap owned by another stack', async () => {
    gateway.status = 'FAILED'; mocks.targets = []; mocks.tagOwner = 'different-stack';
    await expect(handler({ RequestType: 'Create', ResourceProperties: props })).rejects.toThrow('does not belong');
    expect(commands()).not.toContain('DeleteGatewayCommand');
    expect(commands()).not.toContain('CreateGatewayCommand');
  });
});

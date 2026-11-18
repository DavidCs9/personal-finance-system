import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { Function as Lambda, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { expect, it } from 'vitest';
import { financeMcpGateway, financeMcpOAuth, MCP_BOOTSTRAP_AUDIENCE } from '../lib/mcp-oauth.js';
import { TOOL_DEFINITIONS } from '@finance/api/agent-tool-definitions';

it('uses the existing private pool with a separate code-only read client and keeps the secret out of outputs', () => {
  const stack = new Stack(new App(), 'McpAuth', { env: { account: '123456789012', region: 'us-east-2' } });
  const pool = new UserPool(stack, 'ExistingPool', { selfSignUpEnabled: false });
  const oauth = financeMcpOAuth(stack, pool);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
  template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', { UseCognitoProvidedValues: true });
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlows: ['code'], GenerateSecret: true, EnableTokenRevocation: true,
    AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'phone', 'profile']),
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
    Identifier: { Ref: 'McpOAuthResourceUrl' }, Name: 'Olbia Finance MCP',
    Scopes: [{ ScopeName: 'read', ScopeDescription: 'Read personal financial data' },
      { ScopeName: 'write', ScopeDescription: 'Apply bounded, audited personal financial changes' }],
  });
  const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0] as { Properties: Record<string, unknown> };
  expect(client.Properties.AllowedOAuthScopes).toContainEqual({
    'Fn::Join': ['', [stack.resolve(oauth.resource.userPoolResourceServerId), '/read']],
  });
  expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
  expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_SRP_AUTH');
  expect(JSON.stringify(template.toJSON().Outputs)).not.toContain('ClientSecret');
  const secretLookup = Object.values(template.findResources('Custom::DescribeCognitoUserPoolClient'))[0] as { Properties: { Update: unknown } };
  expect(JSON.stringify(secretLookup.Properties.Update)).toContain('logApiResponseData');
  expect(JSON.stringify(secretLookup.Properties.Update)).toContain('false');
  expect(template.toJSON().Parameters.McpOAuthCallbackUrls.AllowedPattern).not.toContain('.*');
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  template.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
});

it('uses native lifecycle, denies bootstrap tool exposure, and binds read tools to owner/client/scope/audience', () => {
  const stack = new Stack(new App(), 'McpGateway', { env: { account: '123456789012', region: 'us-east-2' } });
  const pool = new UserPool(stack, 'ExistingPool', { selfSignUpEnabled: false });
  const oauth = financeMcpOAuth(stack, pool);
  const tools = new Lambda(stack, 'ExistingReadTools', {
    runtime: Runtime.NODEJS_24_X, handler: 'index.handler', code: Code.fromInline('exports.handler=async()=>({})'),
  });
  financeMcpGateway(stack, { oauth, ownerSub: '11111111-2222-3333-4444-555555555555', tools });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
  template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
  template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
    AuthorizerType: 'CUSTOM_JWT', ProtocolType: 'MCP',
    ProtocolConfiguration: { Mcp: { SupportedVersions: ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'] } },
    AuthorizerConfiguration: { CustomJWTAuthorizer: {
      AllowedAudience: [{ Ref: 'McpOAuthResourceUrl' }], AllowedClients: [stack.resolve(oauth.client.userPoolClientId)],
      AllowedScopes: [{ 'Fn::Join': ['', [stack.resolve(oauth.resource.userPoolResourceServerId), '/read']] }],
      DiscoveryUrl: stack.resolve(oauth.discoveryUrl),
      CustomClaims: [
        { InboundTokenClaimName: 'sub', InboundTokenClaimValueType: 'STRING',
          AuthorizingClaimMatchValue: { ClaimMatchOperator: 'EQUALS', ClaimMatchValue: { MatchValueString: '11111111-2222-3333-4444-555555555555' } } },
        { InboundTokenClaimName: 'token_use', InboundTokenClaimValueType: 'STRING',
          AuthorizingClaimMatchValue: { ClaimMatchOperator: 'EQUALS', ClaimMatchValue: { MatchValueString: 'access' } } },
      ],
    } },
  });
  const json = template.toJSON();
  expect(json.Parameters.McpOAuthResourceUrl.Default).toBe(MCP_BOOTSTRAP_AUDIENCE);
  expect(json.Conditions.FinanceMcpAudienceBound).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'McpOAuthResourceUrl' }, MCP_BOOTSTRAP_AUDIENCE] }] });
  const target = Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget'))[0] as any;
  expect(target.Condition).toBe('FinanceMcpAudienceBound');
  expect(target.Properties.TargetConfiguration.Mcp.Lambda.LambdaArn).toEqual(stack.resolve(tools.functionArn));
  expect(target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload.map((t: { Name: string }) => t.Name)).toEqual(TOOL_DEFINITIONS.map(t => t.name));
  expect(target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload.map((t: { Name: string }) => t.Name))
    .toEqual(expect.arrayContaining(['get_future_commitments', 'get_month_details', 'get_credit_card_cycles', 'get_wealth_history']));
  expect(JSON.stringify(json)).not.toContain('Custom::FinanceMcpOAuth');
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).toContain('lambda:InvokeFunction');
  expect(policies).toContain('bedrock-agentcore:AuthorizeAction');
  expect(policies).toContain('bedrock-agentcore:PartiallyAuthorizeActions');
  expect(policies).not.toContain('bedrock-agentcore:UpdateGateway');
  template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { PolicyEngineConfiguration: { Mode: 'ENFORCE', Arn: Match.anyValue() } });
});

it('adds bounded write targets to the same Gateway and keeps read and write policies separate', async () => {
  const { FINANCIAL_WRITE_TOOL_DEFINITIONS } = await import('@finance/api/agent-financial-tool-definitions');
  const { TAG_MUTATION_TOOL_DEFINITIONS } = await import('@finance/api/agent-tag-mutation-tool-definitions');
  const stack = new Stack(new App(), 'McpWrites', { env: { account: '123456789012', region: 'us-east-2' } });
  const oauth = financeMcpOAuth(stack, new UserPool(stack, 'ExistingPool', { selfSignUpEnabled: false }));
  const fn = (id: string) => new Lambda(stack, id, { runtime: Runtime.NODEJS_24_X, handler: 'index.handler', code: Code.fromInline('exports.handler=async()=>({})') });
  financeMcpGateway(stack, { oauth, ownerSub: '11111111-2222-4333-8444-555555555555', tools: fn('Read'), writeTargets: [
    { id: 'IncomeGoalWrites', name: 'olbia-financial-writes', tools: fn('FinancialWrites'), definitions: FINANCIAL_WRITE_TOOL_DEFINITIONS },
    { id: 'ClassificationWrites', name: 'olbia-classification-writes', tools: fn('Classifications'), definitions: TAG_MUTATION_TOOL_DEFINITIONS },
  ] });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
  template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 3);
  template.resourceCountIs('AWS::BedrockAgentCore::PolicyEngine', 1);
  template.resourceCountIs('AWS::BedrockAgentCore::Policy', 3);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  const targets = Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget')) as any[];
  expect(new Set(targets.map(target => JSON.stringify(target.Properties.GatewayIdentifier))).size).toBe(1);
  for (const target of targets) expect(target.Condition).toBe('FinanceMcpAudienceBound');
  const policies = Object.values(template.findResources('AWS::BedrockAgentCore::Policy')) as any[];
  const read = policies.find(policy => policy.Properties.Name === 'FinanceMcpReadPermit');
  expect(JSON.stringify(read.Properties.Definition)).not.toContain('/write');
  const writes = policies.filter(policy => policy !== read);
  for (const policy of writes) {
    expect(policy.Properties.EnforcementMode).toBe('ACTIVE');
    expect(policy.Properties.ValidationMode).toBe('FAIL_ON_ANY_FINDINGS');
    expect(JSON.stringify(policy.Properties.Definition)).toContain('/write');
    expect(JSON.stringify(policy.Properties.Definition)).toContain('11111111-2222-4333-8444-555555555555');
  }
  const writePayload = targets.find(target => target.Properties.Name === 'olbia-financial-writes').Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload;
  expect(writePayload.map((tool: { Name: string }) => tool.Name)).toEqual(FINANCIAL_WRITE_TOOL_DEFINITIONS.map(tool => tool.name));
  template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { Name: 'OlbiaChatGptRead', AuthorizerConfiguration: {
    CustomJWTAuthorizer: Match.objectLike({ AllowedScopes: [{ 'Fn::Join': ['', [stack.resolve(oauth.resource.userPoolResourceServerId), '/read']] }] }),
  } });
});

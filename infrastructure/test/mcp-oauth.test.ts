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
  financeMcpOAuth(stack, pool);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlows: ['code'], GenerateSecret: true, EnableTokenRevocation: true,
    AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'phone', 'profile']),
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
    Identifier: 'olbia-finance', Scopes: [{ ScopeName: 'read', ScopeDescription: 'Read personal financial data' }],
  });
  const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0] as { Properties: Record<string, unknown> };
  expect(client.Properties.AllowedOAuthScopes).toContainEqual(expect.objectContaining({ 'Fn::Join': expect.any(Array) }));
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
      AllowedScopes: ['olbia-finance/read'], DiscoveryUrl: stack.resolve(oauth.discoveryUrl),
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
  expect(JSON.stringify(json)).not.toContain('Custom::FinanceMcpOAuth');
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).toContain('lambda:InvokeFunction');
  expect(policies).not.toContain('bedrock-agentcore:');
});

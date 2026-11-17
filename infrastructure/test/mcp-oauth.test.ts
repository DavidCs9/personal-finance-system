import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { expect, it } from 'vitest';
import { financeMcpOAuth } from '../lib/mcp-oauth.js';

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
});

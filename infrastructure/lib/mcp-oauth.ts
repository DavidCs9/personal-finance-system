import { CfnOutput, CfnParameter, Duration, SecretValue, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export const MCP_READ_SCOPE = 'olbia-finance/read';
export const CHATGPT_BOOTSTRAP_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';

/** Native login for the existing owner; independent of the SPA's SRP client. */
export const financeMcpOAuth = (scope: Construct, userPool: cognito.UserPool) => {
  const stack = Stack.of(scope);
  const callbacks = new CfnParameter(scope, 'McpOAuthCallbackUrls', {
    type: 'CommaDelimitedList',
    default: CHATGPT_BOOTSTRAP_CALLBACK,
    allowedPattern: '^https://chatgpt\\.com/(connector_platform_oauth_redirect|connector/oauth/[A-Za-z0-9_-]+)$',
    description: 'Exact ChatGPT OAuth callbacks. Add the connection-specific callback shown by ChatGPT; no wildcards.',
  });
  const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read personal financial data' });
  const resource = userPool.addResourceServer('FinanceMcpResource', {
    identifier: 'olbia-finance',
    scopes: [readScope],
  });
  const domain = userPool.addDomain('FinanceMcpLogin', {
    cognitoDomain: { domainPrefix: `olbia-finance-${stack.account}-${stack.region}` },
  });
  const client = userPool.addClient('ChatGptMcpClient', {
    userPoolClientName: 'olbia-chatgpt-read-only',
    generateSecret: true,
    preventUserExistenceErrors: true,
    authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
    supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    oAuth: {
      flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
      callbackUrls: callbacks.valueAsList,
      // Cognito advertises these OIDC scopes in discovery; ChatGPT requests them.
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL,
        cognito.OAuthScope.PHONE, cognito.OAuthScope.PROFILE,
        cognito.OAuthScope.resourceServer(resource, readScope)],
    },
    accessTokenValidity: Duration.hours(1),
    idTokenValidity: Duration.hours(1),
    refreshTokenValidity: Duration.days(30),
    enableTokenRevocation: true,
  });
  const credentials = new secretsmanager.Secret(scope, 'ChatGptMcpCredentials', {
    description: 'Static ChatGPT OAuth client credentials. Never publish in outputs or logs.',
    secretObjectValue: {
      clientId: SecretValue.unsafePlainText(client.userPoolClientId),
      clientSecret: client.userPoolClientSecret,
    },
  });
  new CfnOutput(scope, 'McpOAuthClientId', { value: client.userPoolClientId });
  new CfnOutput(scope, 'McpOAuthCredentialsSecretArn', { value: credentials.secretArn });
  new CfnOutput(scope, 'McpOAuthLoginUrl', { value: domain.baseUrl() });
  return { client, domain, resource, credentials,
    discoveryUrl: `https://cognito-idp.${stack.region}.${stack.urlSuffix}/${userPool.userPoolId}/.well-known/openid-configuration` };
};

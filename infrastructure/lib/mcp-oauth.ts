import { CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib';
import { CfnGateway, CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { TOOL_DEFINITIONS } from '@finance/api/agent-tool-definitions';
import type { Construct } from 'constructs';

export const CHATGPT_BOOTSTRAP_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const MCP_BOOTSTRAP_AUDIENCE = 'https://unconfigured.invalid/mcp';

/** Native login for the existing owner; independent of the SPA's SRP client. */
export const financeMcpOAuth = (scope: Construct, userPool: cognito.UserPool) => {
  const stack = Stack.of(scope);
  const resourceUrl = new CfnParameter(scope, 'McpOAuthResourceUrl', {
    type: 'String', default: MCP_BOOTSTRAP_AUDIENCE,
    allowedPattern: '^https://(unconfigured\\.invalid/mcp|olbiachatgptread-[a-z0-9]+\\.gateway\\.bedrock-agentcore\\.[a-z0-9-]+\\.amazonaws\\.com/mcp)$',
    description: 'Native Gateway URL. deploy-production binds this before exposing tools.',
  }).valueAsString;
  const callbacks = new CfnParameter(scope, 'McpOAuthCallbackUrls', {
    type: 'CommaDelimitedList',
    default: CHATGPT_BOOTSTRAP_CALLBACK,
    allowedPattern: '^https://chatgpt\\.com/(connector_platform_oauth_redirect|connector/oauth/[A-Za-z0-9_-]+)$',
    description: 'Exact ChatGPT OAuth callbacks. Add the connection-specific callback shown by ChatGPT; no wildcards.',
  });
  const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read personal financial data' });
  const resource = userPool.addResourceServer('FinanceMcpResource', {
    identifier: resourceUrl,
    scopes: [readScope],
  });
  const readOAuthScope = cognito.OAuthScope.resourceServer(resource, readScope);
  const domain = userPool.addDomain('FinanceMcpLogin', {
    cognitoDomain: { domainPrefix: `olbia-finance-${stack.account}-${stack.region}` },
    managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
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
        readOAuthScope],
    },
    accessTokenValidity: Duration.hours(1),
    idTokenValidity: Duration.hours(1),
    refreshTokenValidity: Duration.days(30),
    enableTokenRevocation: true,
  });
  const branding = new cognito.CfnManagedLoginBranding(scope, 'ChatGptMcpLoginBranding', {
    userPoolId: userPool.userPoolId, clientId: client.userPoolClientId,
    useCognitoProvidedValues: true,
  });
  branding.node.addDependency(domain);
  const credentials = new secretsmanager.Secret(scope, 'ChatGptMcpCredentials', {
    description: 'Static ChatGPT OAuth client credentials. Never publish in outputs or logs.',
    removalPolicy: RemovalPolicy.DESTROY,
    secretObjectValue: {
      clientId: SecretValue.unsafePlainText(client.userPoolClientId),
      clientSecret: client.userPoolClientSecret,
    },
  });
  new CfnOutput(scope, 'McpOAuthClientId', { value: client.userPoolClientId });
  new CfnOutput(scope, 'McpOAuthCredentialsSecretArn', { value: credentials.secretArn });
  new CfnOutput(scope, 'McpOAuthLoginUrl', { value: domain.baseUrl() });
  return { client, domain, resource, credentials, resourceUrl, readOAuthScope,
    discoveryUrl: `https://cognito-idp.${stack.region}.${stack.urlSuffix}/${userPool.userPoolId}/.well-known/openid-configuration` };
};

/** CloudFormation owns the complete lifecycle; no provisioning Lambda. */
export const financeMcpGateway = (scope: Construct, props: {
  oauth: ReturnType<typeof financeMcpOAuth>; ownerSub: string; tools: IFunction;
}) => {
  const bound = new CfnCondition(scope, 'FinanceMcpAudienceBound', {
    expression: Fn.conditionNot(Fn.conditionEquals(props.oauth.resourceUrl, MCP_BOOTSTRAP_AUDIENCE)),
  });
  const role = new iam.Role(scope, 'FinanceMcpGatewayRole', {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    description: 'ChatGPT Gateway can invoke only the existing read-only finance Lambda.',
  });
  const invoke = props.tools.grantInvoke(role);
  const gateway = new CfnGateway(scope, 'FinanceMcpReadGateway', {
    name: 'OlbiaChatGptRead', roleArn: role.roleArn, protocolType: 'MCP', authorizerType: 'CUSTOM_JWT',
    protocolConfiguration: { mcp: { supportedVersions: ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'] } },
    authorizerConfiguration: { customJwtAuthorizer: {
      discoveryUrl: props.oauth.discoveryUrl, allowedClients: [props.oauth.client.userPoolClientId],
      allowedAudience: [props.oauth.resourceUrl], allowedScopes: [props.oauth.readOAuthScope.scopeName],
      customClaims: [['sub', props.ownerSub], ['token_use', 'access']].map(([name, value]) => ({
        inboundTokenClaimName: name!, inboundTokenClaimValueType: 'STRING',
        authorizingClaimMatchValue: { claimMatchOperator: 'EQUALS', claimMatchValue: { matchValueString: value! } },
      })),
    } },
  });
  invoke.applyBefore(gateway);
  gateway.node.addDependency(props.oauth.client, props.oauth.domain);
  const target = new CfnGatewayTarget(scope, 'FinanceMcpReadTarget', {
    gatewayIdentifier: gateway.ref, name: 'olbia-tools',
    credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    targetConfiguration: { mcp: { lambda: {
      lambdaArn: props.tools.functionArn,
      toolSchema: { inlinePayload: JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as CfnGatewayTarget.ToolDefinitionProperty[] },
    } } },
  });
  target.cfnOptions.condition = bound;
  new CfnOutput(scope, 'FinanceMcpUrl', { value: gateway.attrGatewayUrl });
  return gateway;
};

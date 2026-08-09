import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class GitHubCiBootstrapStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    Object.entries({ Project: 'personal-finance-system', Environment: 'prod', ManagedBy: 'cdk' })
      .forEach(([key, value]) => cdk.Tags.of(this).add(key, value));

    const githubActionsOidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubActionsOidcProvider',
      `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: 'personal-finance-v1-github-deploy',
      description: 'Allows GitHub Actions from the protected main branch to deploy PersonalFinanceV1.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubActionsOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': 'repo:DavidCs9@105255351/personal-finance-system@1319548923:ref:refs/heads/main',
        },
      }),
    });
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-${this.region}`,
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`,
        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/personal-finance-v1/agent/runtime-system-prompt-version-arn`,
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:GetPrompt'],
      resources: [`arn:${this.partition}:bedrock:${this.region}:${this.account}:prompt/*`],
    }));

    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
  }
}

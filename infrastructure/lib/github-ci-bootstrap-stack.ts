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
    const githubAudience = {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    };
    const mainDeploy = new iam.WebIdentityPrincipal(githubActionsOidcProvider.openIdConnectProviderArn, {
      StringEquals: {
        ...githubAudience,
        'token.actions.githubusercontent.com:sub':
          'repo:DavidCs9@105255351/personal-finance-system@1319548923:ref:refs/heads/main',
      },
    });
    const pullRequestProbe = new iam.WebIdentityPrincipal(githubActionsOidcProvider.openIdConnectProviderArn, {
      StringEquals: {
        ...githubAudience,
        'token.actions.githubusercontent.com:sub':
          'repo:DavidCs9@105255351/personal-finance-system@1319548923:pull_request',
      },
    });
    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: 'personal-finance-v1-github-deploy',
      description: 'Allows GitHub Actions from main to deploy, and from pull requests to probe email Textract.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.CompositePrincipal(mainDeploy, pullRequestProbe),
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
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`],
    }));

    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
  }
}

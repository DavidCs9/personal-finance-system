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
      description: 'Allows GitHub Actions from the protected main branch to deploy PersonalFinance stacks.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubActionsOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': 'repo:DavidCs9@105255351/personal-finance-system@1319548923:ref:refs/heads/main',
        },
      }),
    });
    // us-east-1 hosts the CloudFront ACM certificate stack and cross-region reference support.
    const bootstrapRegions = [this.region, 'us-east-1'];
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: bootstrapRegions.flatMap((region) => [
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${region}`,
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${region}`,
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-${region}`,
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${region}`,
      ]),
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: bootstrapRegions.map(
        (region) => `arn:${this.partition}:ssm:${region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`,
      ),
    }));

    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
  }
}

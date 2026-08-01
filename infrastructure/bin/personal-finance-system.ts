#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GitHubCiBootstrapStack } from '../lib/github-ci-bootstrap-stack.js';
import { PersonalFinanceV1Stack } from '../lib/personal-finance-v1-stack.js';

const app = new cdk.App();

new PersonalFinanceV1Stack(app, 'PersonalFinanceV1', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-2',
  },
  description: 'Serverless personal-finance email ingestion system (V1).',
  tags: {
    Project: 'personal-finance-system',
    Environment: 'prod',
    ManagedBy: 'cdk',
  },
});

new GitHubCiBootstrapStack(app, 'PersonalFinanceCiBootstrap', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-2',
  },
  description: 'OIDC deployment access for the personal-finance GitHub Actions workflow.',
});

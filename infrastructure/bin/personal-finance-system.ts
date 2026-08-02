#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GitHubCiBootstrapStack } from '../lib/github-ci-bootstrap-stack.js';
import { PersonalFinanceV1Stack } from '../lib/personal-finance-v1-stack.js';
import { PersonalFinanceWebCertificateStack } from '../lib/web-certificate-stack.js';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const tags = {
  Project: 'personal-finance-system',
  Environment: 'prod',
  ManagedBy: 'cdk',
};

const webCertificateStack = new PersonalFinanceWebCertificateStack(app, 'PersonalFinanceWebCertificate', {
  env: {
    account,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  description: 'CloudFront TLS certificate for finance.castrodavid.dev (must live in us-east-1).',
  tags,
});

new PersonalFinanceV1Stack(app, 'PersonalFinanceV1', {
  env: {
    account,
    region: 'us-east-2',
  },
  crossRegionReferences: true,
  webCertificate: webCertificateStack.certificate,
  webDomainName: webCertificateStack.domainName,
  description: 'Serverless multi-source personal-finance ingestion system (V1).',
  tags,
});

new GitHubCiBootstrapStack(app, 'PersonalFinanceCiBootstrap', {
  env: {
    account,
    region: 'us-east-2',
  },
  description: 'OIDC deployment access for the personal-finance GitHub Actions workflow.',
});

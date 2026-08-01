#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
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

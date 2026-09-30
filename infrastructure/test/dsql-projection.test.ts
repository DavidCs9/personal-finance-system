import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { beforeAll, describe, expect, it } from 'vitest';
import { DsqlProjection } from '../lib/dsql-projection';

const stackFor = (projection: boolean): Stack => {
  const stack = new Stack(new App(), 'Test', { env: { account: '225989371926', region: 'us-east-2' } });
  const encryptionKey = new kms.Key(stack, 'DataEncryptionKey', { removalPolicy: RemovalPolicy.RETAIN });
  const table = new dynamodb.Table(stack, 'MetadataTable', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_IMAGE, encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey,
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: 'expiresAt',
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 35 }, removalPolicy: RemovalPolicy.RETAIN,
  });
  for (const index of ['GSI1', 'GSI2', 'GSI3']) table.addGlobalSecondaryIndex({ indexName: index,
    partitionKey: { name: `${index}PK`, type: dynamodb.AttributeType.STRING }, sortKey: { name: `${index}SK`, type: dynamodb.AttributeType.STRING } });
  if (projection) new DsqlProjection(stack, 'DsqlProjection', { table, encryptionKey, alertRecipientEmail: 'owner@example.com' });
  return stack;
};

let baseline: Template;
let migrated: Template;
beforeAll(() => {
  baseline = Template.fromStack(stackFor(false));
  migrated = Template.fromStack(stackFor(true));
}, 60_000);

describe('DSQL migration infrastructure safety', () => {
  it('keeps source table identity, indices, TTL, stream, encryption, PITR and retain policies identical', () => {
    expect(migrated.findResources('AWS::DynamoDB::Table')).toEqual(baseline.findResources('AWS::DynamoDB::Table'));
  });
  it('gates capture on schema, retains recovery, restricts runtime permissions and routes failures to operational alarms', () => {
    const template = migrated;
    template.hasResource('AWS::DSQL::Cluster', { Properties: { DeletionProtectionEnabled: true }, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', Properties: { VersioningConfiguration: { Status: 'Enabled' } } });
    const mappings = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'));
    expect(mappings).toHaveLength(1);
    const mapping = mappings[0];
    expect(mapping.Properties).toMatchObject({ StartingPosition: 'TRIM_HORIZON', FunctionResponseTypes: ['ReportBatchItemFailures'], MetricsConfig: { Metrics: ['EventCount'] } });
    expect(mapping.DependsOn.some((dependency: string) => dependency.includes('Bootstrap'))).toBe(true);
    expect(mapping.Properties.DestinationConfig.OnFailure.Destination).toBeDefined();
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [id, policy] of Object.entries(policies)) {
      if (!/ProjectorServiceRole|MaintenanceServiceRole|ReplayServiceRole/.test(id)) continue;
      const actions = policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) => statement.Action);
      expect(actions).toContain('dsql:DbConnect'); expect(actions).not.toContain('dsql:DbConnectAdmin');
      expect(actions).not.toContain('dynamodb:PutItem'); expect(actions).not.toContain('dynamodb:UpdateItem'); expect(actions).not.toContain('dynamodb:DeleteItem');
      expect(actions).not.toContain('s3:DeleteObject*');
    }
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) expect(alarm.Properties.AlarmActions.length).toBeGreaterThan(0);
    const definition = JSON.stringify(Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0].Properties.DefinitionString);
    expect(definition).toContain('ParityFailed'); expect(definition).toContain('ResumeOrInitialize');
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    expect(JSON.stringify(template.findResources('AWS::SNS::TopicPolicy'))).toContain('cloudwatch.amazonaws.com');
    expect(JSON.stringify(template.findResources('AWS::SNS::TopicPolicy'))).toContain('sns:Publish');
  });
});

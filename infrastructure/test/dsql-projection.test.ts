import { SQL_AUTHORITY } from '../lib/storage-cutover';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DsqlProjection } from '../lib/dsql-projection';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

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
  if (projection) {
    const dsql = new DsqlProjection(stack, 'DsqlProjection', { table, encryptionKey, alertRecipientEmail: 'owner@example.com' });
    const reader = new NodejsFunction(stack, 'ApiReader', { runtime: Runtime.NODEJS_24_X,
      entry: path.resolve(__dirname, '../lambda/dsql-schema.ts'), handler: 'handler' });
    dsql.grantReader(reader);
  }
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
    expect(Object.values(template.findResources('AWS::CloudFormation::CustomResource'))[0].Properties.Version).toBe(11);
  });
  it('can import every retained synthesized DSQL resource without updating the source table or encryption key', () => {
    const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('recover','scripts/recover-dsql-resources.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
current,desired=json.load(sys.stdin)
events=[dict(LogicalResourceId=name,ResourceType=resource['Type'],ResourceStatus='DELETE_SKIPPED',PhysicalResourceId=name) for name,resource in desired['Resources'].items() if name.startswith('DsqlProjection') and resource.get('DeletionPolicy')=='Retain']
template,imports=module.import_plan(current,desired,events)
assert all(template['Resources'][name]==resource for name,resource in current['Resources'].items())
assert len(imports)==10
print(len(imports))
`;
    const result = spawnSync('python3', ['-c', script], { cwd: path.resolve(__dirname, '..'),
      input: JSON.stringify([baseline.toJSON(), migrated.toJSON()]), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('10');
  });
  it('allows native S3 destination validation across the dedicated bucket without deletion or other-account writes', () => {
    const recoveryId = Object.keys(migrated.findResources('AWS::S3::Bucket'))[0];
    const projectorPolicy = Object.entries(migrated.findResources('AWS::IAM::Policy'))
      .find(([id]) => id.includes('ProjectorServiceRole'))![1];
    const statements = projectorPolicy.Properties.PolicyDocument.Statement;
    const put = statements.find((statement: { Action: string }) => statement.Action === 's3:PutObject');
    expect(put.Resource).toEqual({ 'Fn::Join': ['', [{ 'Fn::GetAtt': [recoveryId, 'Arn'] }, '/*']] });
    expect(put.Condition).toEqual({ StringEquals: { 's3:ResourceAccount': { Ref: 'AWS::AccountId' } } });
    expect(statements.find((statement: { Action: string }) => statement.Action === 's3:ListBucket').Resource)
      .toEqual({ 'Fn::GetAtt': [recoveryId, 'Arn'] });
    expect(JSON.stringify(statements)).not.toContain('s3:DeleteObject');
  });
  it('maps a read-only API identity and waits for reader bootstrap without source or SQL admin/write grants', () => {
    const api = Object.entries(migrated.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('ApiReader'))![1];
    expect(api.Properties.Environment.Variables.DSQL_ENDPOINT).toBeDefined();
    expect(api.DependsOn.some((id: string) => id.includes('Bootstrap'))).toBe(true);
    const bootstrap = Object.values(migrated.findResources('AWS::CloudFormation::CustomResource'))[0];
    expect(bootstrap.Properties.ReaderRoleArns).toHaveLength(1);
    const policy = Object.entries(migrated.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('ApiReader'))![1];
    const actions = policy.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) => s.Action);
    expect(actions).toContain('dsql:DbConnect');
    expect(actions).not.toContain('dsql:DbConnectAdmin');
    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:UpdateItem');
  });
});

it('grants native encrypted backup both decrypt and data-key generation only on the existing key',()=>{
  const keyId=Object.keys(migrated.findResources('AWS::KMS::Key'))[0];
  const policy=Object.entries(migrated.findResources('AWS::IAM::Policy')).find(([id])=>id.includes('DsqlProjectionDeployRolePolicy'))![1];
  const statements=policy.Properties.PolicyDocument.Statement;
  const cryptographic=statements.find((statement:{Action:string|string[]})=>(Array.isArray(statement.Action)?statement.Action:[statement.Action]).includes('kms:GenerateDataKey*'));
  expect(cryptographic.Action).toContain('kms:Decrypt');
  expect(cryptographic.Resource).toEqual({'Fn::GetAtt':[keyId,'Arn']});
});

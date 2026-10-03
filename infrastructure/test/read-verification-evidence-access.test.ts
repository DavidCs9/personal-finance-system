import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Source } from 'aws-cdk-lib/aws-s3-deployment';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonalFinanceV1Stack } from '../lib/personal-finance-v1-stack.js';

afterEach(()=>vi.restoreAllMocks());
it('gives the deployed verifier read-only access to every supported evidence family',()=>{
  // CI tests precede the web build. Substitute only that unrelated deployment
  // asset; the actual verifier function, role and native S3 grants are synthesized.
  const originalAsset=Source.asset.bind(Source);
  vi.spyOn(Source,'asset').mockImplementation((assetPath,options)=>assetPath.endsWith('/apps/web/dist')
    ? Source.data('index.html','Evidence policy test') : originalAsset(assetPath,options));
  const template=Template.fromStack(new PersonalFinanceV1Stack(new App(),'EvidenceAccess',{
    env:{account:'225989371926',region:'us-east-2'},
  }));
  const fn=Object.values(template.findResources('AWS::Lambda::Function')).find(
    resource=>resource.Properties.FunctionName==='personal-finance-v1-dsql-read-verification');
  expect(fn).toBeDefined();
  const role=fn!.Properties.Role['Fn::GetAtt'][0];
  const statements=Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy=>policy.Properties.Roles.some((value:{Ref?:string})=>value.Ref===role))
    .flatMap(policy=>policy.Properties.PolicyDocument.Statement);
  const actions=(statement:{Action:string|string[]})=>Array.isArray(statement.Action)?statement.Action:[statement.Action];
  const reads=statements.filter(statement=>actions(statement).includes('s3:GetObject*'));
  const rawBucket=Object.keys(template.findResources('AWS::S3::Bucket')).find(id=>id.startsWith('RawEmailBucket'))!;
  const objectResources=reads.flatMap(statement=>Array.isArray(statement.Resource)?statement.Resource:[statement.Resource])
    .filter(resource=>resource['Fn::Join']!==undefined);
  const expected=['inbound/*','manual-entries/*','manual-imports/cfdi-nomina/*','manual-imports/amex/*','manual-imports/santander/*',
    'manual-imports/santander-statement/*','wealth-manual/*','wealth-api/*'];
  expect(objectResources).toHaveLength(expected.length);
  for(const prefix of expected)expect(objectResources).toContainEqual({
    'Fn::Join':['',[{'Fn::GetAtt':[rawBucket,'Arn']},`/${prefix}`]],
  });
  expect(statements.flatMap(actions).some(action=>/^s3:(?:Put|Delete|\*)/.test(action))).toBe(false);
  const schema=Object.values(template.findResources('AWS::Lambda::Function')).find(r=>r.Properties.FunctionName==='personal-finance-v1-dsql-schema')!;
  const schemaRole=schema.Properties.Role['Fn::GetAtt'][0];
  const schemaStatements=Object.values(template.findResources('AWS::IAM::Policy')).filter(p=>p.Properties.Roles.some((r:{Ref?:string})=>r.Ref===schemaRole)).flatMap(p=>p.Properties.PolicyDocument.Statement);
  const originalReads=schemaStatements.filter(s=>actions(s).includes('s3:GetObject*'));
  expect(originalReads).toHaveLength(1);
  expect(originalReads[0].Resource).toEqual([
    {'Fn::GetAtt':[rawBucket,'Arn']},
    {'Fn::Join':['',[{'Fn::GetAtt':[rawBucket,'Arn']},'/inbound/*']]},
  ]);
  expect(schema.Properties.Environment.Variables.RAW_EMAIL_BUCKET_NAME).toEqual({Ref:rawBucket});
  expect(schemaStatements.flatMap(actions).some(a=>/^s3:(?:Put|Delete|\*)/.test(a))).toBe(false);
  expect(schemaStatements.flatMap(actions)).toContain('kms:Decrypt');
  const bootstrap=Object.values(template.findResources('AWS::CloudFormation::CustomResource')).find(r=>r.Properties.Version===21)!;
  const schemaPolicy=Object.keys(template.findResources('AWS::IAM::Policy')).find(id=>id.startsWith('DsqlProjectionSchemaServiceRoleDefaultPolicy'))!;
  expect(bootstrap.DependsOn).toContain(schemaPolicy);
  const functions=template.findResources('AWS::Lambda::Function');
  for(const resource of Object.values(functions))
    expect(resource.Properties.Environment?.Variables ?? {}).not.toHaveProperty('DSQL_LEDGER_READ_MODE');

},60_000);

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
  const expected=['manual-imports/cfdi-nomina/*','manual-imports/amex/*','manual-imports/santander/*',
    'manual-imports/santander-statement/*','wealth-manual/*','wealth-api/*'];
  expect(objectResources).toHaveLength(expected.length);
  for(const prefix of expected)expect(objectResources).toContainEqual({
    'Fn::Join':['',[{'Fn::GetAtt':[rawBucket,'Arn']},`/${prefix}`]],
  });
  expect(statements.flatMap(actions).some(action=>/^s3:(?:Put|Delete|\*)/.test(action))).toBe(false);
},60_000);

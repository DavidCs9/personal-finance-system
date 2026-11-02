import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/** Preserve the existing parameter identities and keep all private text NoEcho. */
export function managedPromptTextParameters(scope: Construct): cdk.CfnParameter[] {
  return Array.from({ length: 8 }, (_, index) => new cdk.CfnParameter(scope, `OlbiaSystemPromptTextPart${index + 1}`, {
    type: 'String',
    noEcho: true,
    maxLength: 4096,
    ...(index >= 2 ? { default: '' } : {}),
    description: `Part ${index + 1} of the current Olbia DRAFT, read from Prompt Management by CI.`,
  }));
}

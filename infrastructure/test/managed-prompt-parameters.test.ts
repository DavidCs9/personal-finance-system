import { App, CfnResource, Fn, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { managedPromptTextParameters } from '../lib/managed-prompt-parameters.js';

it('keeps native private parameters compatible while expanding prompt capacity', () => {
  const stack = new Stack(new App(), 'PromptTransport');
  const parts = managedPromptTextParameters(stack);
  new CfnResource(stack, 'Prompt', {
    type: 'AWS::Bedrock::Prompt',
    properties: {
      Name: 'TransportFixture', DefaultVariant: 'Text',
      Variants: [{ Name: 'Text', TemplateType: 'TEXT', TemplateConfiguration: {
        Text: { Text: Fn.join('', parts.map(part => part.valueAsString)) },
      } }],
    },
  });
  const parameters = Template.fromStack(stack).toJSON().Parameters;
  for (let index = 1; index <= 8; index++) {
    expect(parameters[`OlbiaSystemPromptTextPart${index}`]).toMatchObject({
      Type: 'String', NoEcho: true, MaxLength: 4096,
    });
    if (index <= 2) expect(parameters[`OlbiaSystemPromptTextPart${index}`]).not.toHaveProperty('Default');
    else expect(parameters[`OlbiaSystemPromptTextPart${index}`].Default).toBe('');
  }
});

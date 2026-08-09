# Olbia agent runtime

The system-prompt content is owned exclusively by Amazon Bedrock Prompt Management. It is never stored, seeded, or hardcoded in this repository.

Runtime resolution:

1. SSM parameter `/personal-finance-v1/agent/runtime-system-prompt-version-arn` contains the ARN of an immutable Prompt Management version.
2. The AgentCore provisioner reads that version when it creates or reconciles the Harness.
3. Each chat invocation reads the same pointer (with a short in-memory cache), calls `GetPrompt`, and overrides the Harness system prompt, model, temperature, and maximum tokens.

The active Prompt Management version must contain:

- a non-empty text or chat-system prompt;
- `modelId`;
- text inference configuration with `temperature` and `maxTokens`.

Prompt changes are operational runtime changes. Edit the Prompt Management draft, create an immutable version, and move the SSM pointer. Do not add prompt prose, model defaults, inference defaults, bootstrap prompts, or fallback prompts to application or infrastructure code.

CDK owns the native `AWS::Bedrock::Prompt` resource (stable name, tags, retention, and lifecycle). Before deployment, CI reads the current DRAFT directly from Prompt Management and passes its text, model, and inference settings as CloudFormation `NoEcho` parameters. This preserves the DRAFT without storing prompt content in Git or application code. Immutable versions and promotion remain runtime operations in Prompt Management; the active SSM pointer is an operational prerequisite.

AgentCore Harness, Memory, and Gateway run in `us-east-1`, the region required by the AWS-managed Web Search Tool connector. The finance tool Lambda and DynamoDB source data remain in `us-east-2`; Gateway invokes the Lambda cross-region.

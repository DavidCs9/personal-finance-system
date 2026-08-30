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

Golden behavior for decision-support prompts is guarded in two layers:

1. `plan_month_scenario` performs currency conversion, commitments, inclusive calendar-day counts, nights, daily ceilings, and month-close scenarios deterministically.
2. `golden-thread-evaluation.test.ts` rejects the prior failure mode (asking the user to invent the budget they asked the agent to derive) and checks the expected financial/date outputs without an LLM call. Production releases use two bounded Harness canaries, not a recurring evaluation job.

Prompt changes are operational runtime changes. Edit the Prompt Management draft, create an immutable version, and move the SSM pointer. Do not add prompt prose, model defaults, inference defaults, bootstrap prompts, or fallback prompts to application or infrastructure code.

## Binding prompt-preservation rule

Olbia is a single-owner personal system. Every new runtime prompt version must preserve the latest explicit personal-profile and voice sections unless the owner explicitly changes or removes them. A generic assistant prompt is never an acceptable replacement or fallback for those sections.

Before creating or promoting a prompt version:

1. Read the currently active immutable version and the latest immutable version containing the owner's personal profile.
2. Merge new behavior into that personalized baseline; do not rebuild from a generic prompt or copy only the newest behavioral appendix.
3. Verify the candidate still contains the personal-profile section, voice section, existing operational rules, and every behavior intentionally retained from the active version.
4. Create a new immutable Prompt Management version, read it back, verify those sections again, and only then move the SSM pointer.
5. Keep private profile prose in Bedrock Prompt Management. Do not commit biography, priorities, dates, or other personal details to this public repository, CloudFormation templates, Lambda environment variables, logs, or test fixtures.

Version `10` is the current preservation baseline: it combines the private personal profile retained in v5 with the continuity rules from v9 and the investment-history/web-research rules. Future versions must be additive from v10 or an explicitly approved successor, not from the generic v9 text.

CDK owns the native `AWS::Bedrock::Prompt` resource (stable name, tags, retention, and lifecycle). Before deployment, CI reads the current DRAFT directly from Prompt Management and passes its text, model, and inference settings as CloudFormation `NoEcho` parameters. This preserves the DRAFT without storing prompt content in Git or application code. Immutable versions and promotion remain runtime operations in Prompt Management; the active SSM pointer is an operational prerequisite.

AgentCore Harness, Memory, and the Web Search Gateway run in `us-east-1`, the region required by the AWS-managed connector. The existing finance Gateway, tool Lambda, and DynamoDB source data remain together in `us-east-2`. The Harness attaches both Gateways.

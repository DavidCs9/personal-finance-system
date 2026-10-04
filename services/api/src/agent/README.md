# Olbia agent runtime

The binding [assistant guide](../../../../docs/ai-assistant.md) owns runtime access, tools, conversation/memory boundaries and **prompt-preservation rules**. Read its Prompt Management section before creating or promoting any version; preserve the latest explicit private profile/voice and retained behavior unless David explicitly changes them. No generic/profile-less fallback or hardcoded prompt/model/inference defaults.

Private prompt content stays exclusively in Bedrock Prompt Management. The SSM pointer selects an immutable version, resolved by [prompt-runtime.ts](prompt-runtime.ts); code deployment does not promote it. Never commit private profile prose, seeds or runtime content.

Scenario math is deterministic in [month-scenario.ts](month-scenario.ts). [Golden-thread tests](golden-thread-evaluation.test.ts) guard the failure mode of asking David to invent a budget he asked Olbia to derive. Production uses bounded Harness canaries, not a recurring evaluation job. Exact contracts and adapters live beside this README; document lasting behavior in the canonical guide rather than duplicating it here.

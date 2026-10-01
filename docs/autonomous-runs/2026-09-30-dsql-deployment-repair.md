# DSQL deployment repair — 2026-09-30

## Objective and completion criteria

Repair the failed DSQL rollout autonomously. Complete the required PR/quality/linear merge workflow, obtain a successful deploy-production run, and verify bootstrap, projection and parity against production data while preserving DynamoDB and the existing application.

## Constraints

- David authorized full administration and autonomous repair without further consultation.
- Production code/infrastructure changes only through approved main and deploy-production; no local deployment shortcuts.
- DynamoDB remains authoritative and must not be deleted, replaced or mutated to trigger replication.
- Use aws login credentials for local diagnosis and verify identity before production operations.
- Preserve financial data, retained DSQL resources and unrelated work.

## Progress and next steps

- Read autonomous rules, product north star and repository guidance.
- Clean checkout; fetched origin/main and created codex/repair-dsql-deployment directly from it.
- PRs #145 and #146 passed quality but their main deployments failed. Latest failure is CloudFormation create-change-set during retained-resource adoption.
- Confirmed Unicode corruption in GetTemplate as the recovery root cause. Retrieved the original deployed CDK S3 template and verified its SHA-256 and exact correspondence to live state after reproducing the API's lossy conversion.
- Corrected recovery to retrieve/check the immutable artifact and reject unrelated live changes. Added Unicode/unrelated-change regression tests and updated runbook.
- Native corrected import preview reached CREATE_COMPLETE with exactly eight Import actions and no other changes. Both diagnostic previews were deleted without execution.
- Next: publish PR, confirm quality/CLEAN/MERGEABLE, merge and monitor production bootstrap and parity.

## Decisions

### D1 — Preserve the original deployed template during retained-resource import
- Context: The prior recovery copied GetTemplate output verbatim, but AWS rejected import as application modifications.
- Evidence and uncertainty: An unexecuted diagnostic UPDATE preview identifies three descriptions and the mutation tool schema as direct modifications. GetTemplate replaced every non-ASCII character with `?`. The original CDK S3 artifact `4b7dec2e3164baca19e6564f242c2347d2612b4e48ac55cb7494ab4a52c6eae6.json` from the last successful deployment exactly matches the entire live template after reproducing that lossy conversion. No diagnostic change set was executed.
- Alternatives and tradeoffs: Guess Unicode from current source (ambiguous); normalize production descriptions/tools (unnecessary application update); recover the immutable original artifact and verify every original resource/top-level section against the live template before import.
- Decision and reason: Use the verified original deployment artifact for this bounded recovery, reject any other difference and preserve all existing resources. Existing CDK file-publishing permissions can retrieve the artifact; no new provider or privileges required.
- Consequences, verification, and revisit conditions: This explicit recovery artifact is specific to the failed rollout. Already-owned resources continue to skip import. Add regression coverage for Unicode corruption and unrelated changes; inspect the native import-only preview in CI before execution.
- Status: Cause validated against production; implementation and deployment pending.

## Verification results

- 377 application/infrastructure tests and nine Python recovery tests passed.
- Ledger, web and infrastructure type checks passed; web production build and CDK synth passed.
- Corrected import preview accepted by CloudFormation; no diagnostic preview executed.
- Original artifact SHA-256 verified; all 268 existing resources match it exactly (restoring only Unicode lost by GetTemplate).
- `git diff --check` passed.

## Outcome and remaining work

Repair, production deployment and runtime verification are in progress.

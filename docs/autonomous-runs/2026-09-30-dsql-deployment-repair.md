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
- [PR #147](https://github.com/DavidCs9/personal-finance-system/pull/147) passed required quality on commit `4484b6972b15369b6fafdb9d41f197d3808c914a`; confirmed CLEAN and MERGEABLE, then squash-merged as `b6241870246d48405304d467438fbc685a80a217` within David's autonomous repair authorization.
- [Production run 36798503418](https://github.com/DavidCs9/personal-finance-system/actions/runs/36798503418) recovered all eight resources and passed bootstrap, then failed native Lambda S3 destination validation. Next: correct the destination permission and continue historical load, parity and live stream verification.

## Decisions

### D2 — Match Lambda's native S3 destination permission validation
- Context: After #147 recovered all retained resources and bootstrap passed, deployment failed creating the DynamoDB event source mapping: its execution role lacked acceptable PutObject permission for the failure destination.
- Evidence and uncertainty: Production run 36798503418 confirms successful adoption and schema/non-admin smoke, then CREATE_FAILED on the mapping. The existing policy restricts writes to `aws/lambda/*`; AWS's documented destination policy grants bucket object scope (`bucket/*`) and restricts the resource account. DynamoDB remains authoritative and the failed rollout completed rollback.
- Alternatives and tradeoffs: Remove recovery (would lose failed payloads); grant broad S3 writes or use CDK's helper with DeleteObject (unnecessary privileges); allow PutObject on all objects in the single private recovery bucket with the existing same-account condition, retaining replay read-prefix restrictions and no deletion permission.
- Decision and reason: Use the provider-compatible bucket object scope for native destination validation, preserving the narrow action, exact bucket and account guard. The native helper's additional delete permission remains an explicit gap justifying the existing small binding.
- Consequences, verification, and revisit conditions: Lambda can write anywhere in this dedicated recovery bucket; it still cannot delete objects or write other buckets. Add a synthesized-policy regression check and verify mapping creation and data parity in the approved production job.
- Status: Implementing; real production acceptance pending.

### D1 — Preserve the original deployed template during retained-resource import
- Context: The prior recovery copied GetTemplate output verbatim, but AWS rejected import as application modifications.
- Evidence and uncertainty: An unexecuted diagnostic UPDATE preview identifies three descriptions and the mutation tool schema as direct modifications. GetTemplate replaced every non-ASCII character with `?`. The original CDK S3 artifact `4b7dec2e3164baca19e6564f242c2347d2612b4e48ac55cb7494ab4a52c6eae6.json` from the last successful deployment exactly matches the entire live template after reproducing that lossy conversion. No diagnostic change set was executed.
- Alternatives and tradeoffs: Guess Unicode from current source (ambiguous); normalize production descriptions/tools (unnecessary application update); recover the immutable original artifact and verify every original resource/top-level section against the live template before import.
- Decision and reason: Use the verified original deployment artifact for this bounded recovery, reject any other difference and preserve all existing resources. Existing CDK file-publishing permissions can retrieve the artifact; no new provider or privileges required.
- Consequences, verification, and revisit conditions: This explicit recovery artifact is specific to the failed rollout. Already-owned resources continue to skip import. Add regression coverage for Unicode corruption and unrelated changes; inspect the native import-only preview in CI before execution.
- Status: Validated in production; all eight retained resources imported successfully by #147.

## Verification results

- 377 application/infrastructure tests and nine Python recovery tests passed.
- Ledger, web and infrastructure type checks passed; web production build and CDK synth passed.
- Corrected import preview accepted by CloudFormation; no diagnostic preview executed.
- Original artifact SHA-256 verified; all 268 existing resources match it exactly (restoring only Unicode lost by GetTemplate).
- `git diff --check` passed.
- Live app HTTP 200. DynamoDB ACTIVE, KMS enabled, NEW_IMAGE stream unchanged, PITR enabled for 35 days. Retained DSQL cluster ACTIVE with deletion protection enabled.
- Remote required quality passed: [run 36798376463](https://github.com/DavidCs9/personal-finance-system/actions/runs/36798376463).

## Outcome and remaining work

Repair, production deployment and runtime verification are in progress.

## Resumed after the first corrective rollout

- #147 restored and imported all eight retained resources. SQL bootstrap and runtime IAM smoke succeeded on the actual DSQL engine.
- The next blocker is the native Lambda S3 failure-destination validation, caused by the prefix-scoped PutObject policy. Rollback retained the imported resources and DynamoDB remains intact.
- User briefly paused work to discuss infrastructure coupling, then explicitly resumed repair and deferred infrastructure tool choices. No architecture/tool migration is in scope.
- Working on codex/fix-dsql-stream-destination, created directly from updated origin/main. Continue with PR/quality/linear merge and production verification.
- Destination policy corrected to exact recovery bucket object scope with the existing account guard. Regression tests check provider-compatible write/list permissions and absence of delete rights. Thirteen infrastructure tests, nine recovery tests, infrastructure type check and synth passed; the source DynamoDB table and all three prior mappings match the original deployed template exactly.
- Native DescribeStackResource confirms the original cluster, recovery bucket and schema log group are still owned by the stack after rollback, with unchanged physical identities.

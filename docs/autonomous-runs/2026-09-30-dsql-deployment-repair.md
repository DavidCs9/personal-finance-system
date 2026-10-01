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

### D3 — Preserve native driver timestamp precision in parity verification
- Context: #148 deployed successfully and loaded the actual ledger, but the parity pass reports hundreds of mismatches with zero lag.
- Evidence and uncertainty: The verifier converts timestamptz values with `new Date(String(value))`. node-postgres returns Date objects; Date.toString omits milliseconds. This deterministically changes a timestamp such as `.123Z` to `.000Z`, while the source's ISO string preserves `.123Z`. Existing embedded PostgreSQL tests did not cover native pg Date parsing. The real parity pass will determine whether further differences remain.
- Alternatives and tradeoffs: Ignore timestamp differences (weakens correctness); change source/SQL data to lower precision (unnecessary loss); preserve Date objects' milliseconds with toISOString and verify with the actual pg parser.
- Decision and reason: Correct comparison normalization, preserving stored source and SQL data. Add a regression using the driver's native timestamptz parser and require real-engine zero-lag/zero-mismatch verification.
- Consequences, verification, and revisit conditions: No schema/source changes. The live reconciliation must pass after rollout; investigate any remaining mismatch separately rather than weakening the gate.
- Status: Validated in production; #149 passed all 3,200 real-data comparisons with zero lag and zero mismatches.

### D2 — Match Lambda's native S3 destination permission validation
- Context: After #147 recovered all retained resources and bootstrap passed, deployment failed creating the DynamoDB event source mapping: its execution role lacked acceptable PutObject permission for the failure destination.
- Evidence and uncertainty: Production run 36798503418 confirms successful adoption and schema/non-admin smoke, then CREATE_FAILED on the mapping. The existing policy restricts writes to `aws/lambda/*`; AWS's documented destination policy grants bucket object scope (`bucket/*`) and restricts the resource account. DynamoDB remains authoritative and the failed rollout completed rollback.
- Alternatives and tradeoffs: Remove recovery (would lose failed payloads); grant broad S3 writes or use CDK's helper with DeleteObject (unnecessary privileges); allow PutObject on all objects in the single private recovery bucket with the existing same-account condition, retaining replay read-prefix restrictions and no deletion permission.
- Decision and reason: Use the provider-compatible bucket object scope for native destination validation, preserving the narrow action, exact bucket and account guard. The native helper's additional delete permission remains an explicit gap justifying the existing small binding.
- Consequences, verification, and revisit conditions: Lambda can write anywhere in this dedicated recovery bucket; it still cannot delete objects or write other buckets. Add a synthesized-policy regression check and verify mapping creation and data parity in the approved production job.
- Status: Validated in production; #148 created the enabled mapping with the native S3 destination. Actual stream delivery captured 102 keys.

### D1 — Preserve the original deployed template during retained-resource import
- Context: The prior recovery copied GetTemplate output verbatim, but AWS rejected import as application modifications.
- Evidence and uncertainty: An unexecuted diagnostic UPDATE preview identifies three descriptions and the mutation tool schema as direct modifications. GetTemplate replaced every non-ASCII character with `?`. The original CDK S3 artifact `4b7dec2e3164baca19e6564f242c2347d2612b4e48ac55cb7494ab4a52c6eae6.json` from the last successful deployment exactly matches the entire live template after reproducing that lossy conversion. No diagnostic change set was executed.
- Alternatives and tradeoffs: Guess Unicode from current source (ambiguous); normalize production descriptions/tools (unnecessary application update); recover the immutable original artifact and verify every original resource/top-level section against the live template before import.
- Decision and reason: Use the verified original deployment artifact for this bounded recovery, reject any other difference and preserve all existing resources. Existing CDK file-publishing permissions can retrieve the artifact; no new provider or privileges required.
- Consequences, verification, and revisit conditions: This explicit recovery artifact is specific to the failed rollout. Already-owned resources continue to skip import. Add regression coverage for Unicode corruption and unrelated changes; inspect the native import-only preview in CI before execution.
- Status: Validated in production; all eight retained resources imported successfully by #147.

## Verification results

- Final corrective PR passed 379 application/infrastructure tests and nine Python recovery tests.
- Ledger, web and infrastructure type checks passed; web production build and CDK synth passed.
- Corrected import preview accepted by CloudFormation; no diagnostic preview executed.
- Original artifact SHA-256 verified; all 268 existing resources match it exactly (restoring only Unicode lost by GetTemplate).
- `git diff --check` passed.
- Live app HTTP 200. DynamoDB ACTIVE, KMS enabled, NEW_IMAGE stream unchanged, PITR enabled for 35 days. Retained DSQL cluster ACTIVE with deletion protection enabled.
- Remote required quality passed: [run 36798376463](https://github.com/DavidCs9/personal-finance-system/actions/runs/36798376463).

## Outcome and remaining work

The authorized deployment repair is complete. [Production run 36801466045](https://github.com/DavidCs9/personal-finance-system/actions/runs/36801466045) passed both quality and deploy-production. Its native reconciliation execution succeeded with projected 3,200, equal 3,200, lag zero and mismatch zero; the gate also confirmed monthly/currency financial aggregates match. All nine relational tables loaded successfully and stream evidence covers 103 keys after recovery replay.

CloudFormation is UPDATE_COMPLETE. The mapping is Enabled with last processing OK and the original stream ARN. DynamoDB remains ACTIVE, KMS encrypted, with unchanged NEW_IMAGE stream and 35-day PITR. DSQL is ACTIVE with deletion protection. The app returns HTTP 200. The configured SNS email subscription is confirmed; the daily native reconciliation remains enabled. Original failure objects remain retained after successful replay.

Infrastructure tool changes and promotion of application reads/writes to SQL remain separate decisions. This repair does not change DynamoDB's authority. No source records were fabricated or modified for verification; no local code deployment or manual SQL DDL was performed. No deployment or data repair work remains. All eight DSQL alarms returned to OK naturally, including the initial backlog iterator-age alarm; none were manually reset or disabled.

## Resumed after the first corrective rollout

- #147 restored and imported all eight retained resources. SQL bootstrap and runtime IAM smoke succeeded on the actual DSQL engine.
- The next blocker is the native Lambda S3 failure-destination validation, caused by the prefix-scoped PutObject policy. Rollback retained the imported resources and DynamoDB remains intact.
- User briefly paused work to discuss infrastructure coupling, then explicitly resumed repair and deferred infrastructure tool choices. No architecture/tool migration is in scope.
- Working on codex/fix-dsql-stream-destination, created directly from updated origin/main. Continue with PR/quality/linear merge and production verification.
- Destination policy corrected to exact recovery bucket object scope with the existing account guard. Regression tests check provider-compatible write/list permissions and absence of delete rights. Thirteen infrastructure tests, nine recovery tests, infrastructure type check and synth passed; the source DynamoDB table and all three prior mappings match the original deployed template exactly.
- Native DescribeStackResource confirms the original cluster, recovery bucket and schema log group are still owned by the stack after rollback, with unchanged physical identities.
- [PR #148](https://github.com/DavidCs9/personal-finance-system/pull/148) passed required quality on `66547dc6e34294ba599836900ec44471ed72e577` ([run 36800160644](https://github.com/DavidCs9/personal-finance-system/actions/runs/36800160644)); confirmed CLEAN and MERGEABLE before squash merge. Awaiting production mapping activation and historical/live parity.
- #148 merged as `1e82496c6acba2181969c9132f9cadc36306b03b`; [production run 36800303862](https://github.com/DavidCs9/personal-finance-system/actions/runs/36800303862) is applying the rollout. Native Lambda confirms mapping `044e9b6c-d091-4b07-938d-d011885aeb3f` is Enabled with the original DynamoDB stream ARN and retained recovery bucket. SQL bootstrap passed again. Historical parity is pending.
- CloudFormation reached UPDATE_COMPLETE. The deployment's historical reconciliation execution (`deploy-36800303862-1`) and the first native scheduled reconciliation are running. Only safe counters/table counts will be recorded; financial aggregates remain private in AWS.
- Activated the configured SNS alarm email subscription via native ConfirmSubscription using the confirmation token from the exact AWS message for the live topic/recipient. Verified topic/account/recipient; no email was sent manually and no tokens were published. Subscription is now confirmed with authenticated unsubscribe required.
- #148's infrastructure deployment succeeded, but its post-deploy parity gate failed. Historical load produced all nine relational tables; verification reported 1,416 equal, zero lag and 1,784 mismatch comparisons across two passes. The 892 distinct mismatches correspond exactly to 491 movements and 401 revisions, the timestamp-bearing entities. Native stream delivery captured 102 keys without artificial source mutations.
- Created codex/fix-dsql-timestamp-parity directly from refreshed origin/main. Native pg parsing reproduces `.123Z` becoming `.000Z` through the previous verifier. The correction preserves Date precision; all 51 ledger tests and ledger type check pass, including equal movement/revision checks and rejection of a one-millisecond SQL discrepancy. Infrastructure synth and whitespace checks pass. Production parity remains the completion gate.
- [PR #149](https://github.com/DavidCs9/personal-finance-system/pull/149) passed required quality ([run 36801314210](https://github.com/DavidCs9/personal-finance-system/actions/runs/36801314210)) on `916de7dd88a43ec7f7dd38a17d33f743a5132ec0`; confirmed CLEAN and MERGEABLE, then squash-merged as `e01b396c6fe1dac788e8bdd99903b38611fa8247`. Awaiting the automatic production rollout and parity rerun.
- [Production run 36801466045](https://github.com/DavidCs9/personal-finance-system/actions/runs/36801466045) is deploying #149. Mapping remains Enabled / last processing OK; native metrics show 14 invocations with zero errors or throttles during initial backlog replay. SNS email subscription is confirmed. Initial backlog iterator age and the known failed parity execution have triggered alarms; verify subsequent health and parity before closure.
- Inspected three native S3 recovery objects: all were RecordAgeExceeded from initial TRIM_HORIZON backlog, containing 1/2/2 records. Replayed all five through the already-deployed `personal-finance-v1-dsql-replay` capability; every invocation returned HTTP 200 with no FunctionError and expected replay counts. The capability rereads current DynamoDB and modifies only SQL. Originals remain retained. This occurred before the corrected deployment's reconciliation starts.
- Corrected maintenance Lambda updated successfully in CloudFormation. Deployment-owned execution `deploy-36801466045-1` is now running the full source/target reconciliation and subsequent comparison passes.
- #149 production run succeeded. Native DescribeExecution confirms SUCCEEDED, 3,200 projected and 3,200 equal comparisons, zero lag/mismatch. Historical and SQL monthly/currency totals match. Stream evidence covers 103 keys; the last timestamp includes the authorized native recovery replay. All three original recovery objects remain intact. Reconciliation failure alarm has returned to OK; initial-backlog iterator-age alarm is still awaiting its native evaluation window.
- Final native checks at 2026-10-01 01:41 UTC confirm all eight DSQL alarms are OK and the rate(1 day) reconciliation schedule is ENABLED with the intended state-machine target. The initial backlog datapoint aged out without any manual alarm mutation. The completed record and runbook precision note are delivered in documentation-only PR #150; required quality and linear merge apply, with no additional production rollout.

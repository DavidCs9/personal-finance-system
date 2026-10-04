# Operations

Current operating guide for David's private application. Use [architecture](architecture.md) for ownership and [financial rules](financial-rules.md) for calculations. Exact resource definitions and schedules live in [the stack](../infrastructure/lib/personal-finance-v1-stack.ts).

## Access and delivery

For interactive local AWS access, use `aws login`; verify `aws sts get-caller-identity` immediately before each production operation. Never replace login with permanent keys. Keep private financial diagnostics and secrets outside this public repository/logs. Financial corrections use authenticated, already-deployed Olbia API/domain operations, preserving validation and revisions; no direct SQL/DynamoDB repair shortcut.

Production code/infrastructure only ships through PR → required `quality` → CLEAN/MERGEABLE → squash or rebase merge → `deploy-production` on main. Never run local `cdk deploy`, update Lambda code/configuration directly or invoke deployment APIs. Fetch/rebase origin/main before final push; use force-with-lease if rebased after publishing, never merge main into the branch. See [repository instructions](../AGENTS.md).

[CI](../.github/workflows/ci-cd.yml) runs Python deployment checks, workspace tests, typechecks, web build and CDK synth. Markdown-only main pushes skip deployment; changing retired-script error pointers can still trigger the normal job. A routine deployment preserves SQL authority, requires mode=sql, and verifies the native catalog, current finances/public reads and original evidence with fully rolled-back write smoke. Deployment-owned catalog retirement verifies retained DynamoDB, removes only allowlisted SQL migration copies and re-runs read/evidence/rollback gates. After retirement the cleanup is idempotent; no verifier requires the removed copies. Unexpected authority or failed checks stop verification; they do not initiate a cutover. [The verification script](../infrastructure/scripts/verify-dsql-deployment.sh) belongs to deploy-production.

## Diagnosis and recovery

Use native Actions/CloudFormation events, Lambda/CloudWatch errors, Scheduler/SQS DLQs and deployed verification results. Inspect the failed stage and retained report before retrying. Provider failure preserves last good wealth data; parser/model failure retains original MIME for review. Retry/discard an ingestion exception through Olbia: dispatcher carries its exact request-time attempt identity and completion is atomic with financial capture. Do not delete DLQ/evidence objects to silence alarms.

Read-only starting point, after login:

```sh
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name PersonalFinanceV1 --region us-east-2 --query 'Stacks[0].Outputs'
```

Outputs identify `DsqlCutoverFunction` and `DsqlReadVerificationFunction`. An authorized diagnostic may invoke the deployed operator with `{"action":"status"}` or the read-only verification function with `{}`; check invocation metadata for FunctionError and the payload for SQL authority/verified/zero mismatches. Do not run activation, reconciliation replay or write smoke as casual diagnosis. Full Step Functions outputs can contain financial aggregates: inspect privately and publish only safe counters. Routine verification is encoded in the script above, not copied as a second deployment path.

Native AWS Backup protects DSQL daily with seven-day retention, defined in [DSQL infrastructure](../infrastructure/lib/dsql-projection.ts). Frozen DynamoDB retains PITR and the pre-cutover backup; original S3 evidence and recovery resources remain retained. Frozen DynamoDB does not contain newer SQL writes and is not an immediate lossless rollback target. Prefer a reviewed SQL fix; restore a native backup to a new cluster through reviewed infrastructure and verification when needed. There is no routine one-command restore here. A return to another authority requires an explicit reviewed transition, copy-back/event-gap decision and restored permissions; flipping a flag is insufficient.

If a failed creation leaves retained resources outside the stack, the deployment-owned [recovery script](../infrastructure/scripts/recover-dsql-resources.py) runs before normal deployment. It imports only proven expected resources with native CloudFormation IMPORT, preserves existing definitions/physical identities and stops on ambiguity or non-import actions. Inspect native change-set/events on failure; a later corrected PR can resume. Never delete retained resources or create replacements to evade conflicts.

## Gmail intake

Recipient: `alertas@inbound.finance.castrodavid.dev`.

1. Gmail Settings → See all settings → Forwarding and POP/IMAP → Add forwarding address.
2. Request confirmation; recover its retained raw MIME code through authorized private diagnostics, then enter it in Gmail. Keep a Gmail copy.
3. Configure filters only for purchase/charge/transfer/billing alerts. Santander: `santander@envio.santander.com.mx`, compra/cargo; Amex: American Express purchase alerts; Nu: `nu.com.mx`, Transferencia fue exitosa; AWS: `invoicing@aws.com`, Billing Statement Available.
4. Adjust with actual incoming formats. Do not forward statements, security messages or unrelated mail. The Gmail confirmation parser is intentionally ignored.

## Apple Pay Shortcut

Read `ApplePayCaptureUrl` and `ApplePayCaptureSecretArn` from stack outputs. Secrets Manager holds the dedicated `.token`; it only authorizes POST /captures/apple-pay. Retrieve privately after verifying identity. Rotate if device/Shortcut trust changes, then update the automation.

On iPhone Shortcuts → Automation → Transaction, select Santander only, Run Immediately, Notify When Run off, New Blank Automation. Keep actions inside the automation; chaining can lose the Transaction type.

Generate UUID as RequestId. Convert input properties to **Text**: AmountRaw from Amount, CurrencyRaw from Amount's Currency/Currency Code, MerchantRaw from Merchant, CardRaw from Card or Pass, NameRaw from Name. Current Date formatted ISO 8601 becomes OccurredAt. Get Contents of URL uses POST, JSON body, Authorization Bearer token, Content-Type application/json and Idempotency-Key RequestId:

```json
{
  "requestId": "<RequestId>",
  "amountRaw": "<AmountRaw>",
  "merchantRaw": "<MerchantRaw>",
  "cardRaw": "<CardRaw>",
  "nameRaw": "<NameRaw>",
  "occurredAt": "<OccurredAt>",
  "institution": "santander_mx",
  "currency": "<CurrencyRaw>"
}
```

Text conversion prevents Currency Amount serialization as zero. Never hardcode MXN for a USD purchase. New capture returns 201; same idempotency key returns 200/same event. Verify a real small iPhone NFC purchase, amount/merchant, replay and later email linkage. Apple Watch and in-app/Safari coverage require separate verification.

## Device and notifications

Safari → finance.castrodavid.dev → Share → Add to Home Screen, Open as Web App on. Sign in inside the installation: its storage/session is separate from Safari. After >1 hour backgrounded, verify refreshed data/session and safe areas. Resume checks session on pageshow/visibility; refreshes coalesce. API 401 refreshes/retries once; rejected refresh credentials clear login, transient network failure does not. Financial queries remain network-based; no offline shell/service-worker cache is introduced. See [web development](../apps/web/README.md).

Resumen's **Avisos de Olbia** requests permission only after a tap and enables the shared Declarative Web Push subscription. Turning off removes device/server subscription. Current UI registers amounts mode; private API mode exists but has no UI toggle. VAPID private key stays in Secrets Manager; only public key enters runtime config. Remove expired 404/410 endpoints; retain on other failures. New-movement push is only new email/Apple Pay events, not manual/CSV/PDF import. Stable daily/card tags suppress stacked retry notices; totals share Resumen's calculation.

## Schedules and integrations

All times below use America/Chihuahua:

| Job | When |
| --- | --- |
| Bitso balances/tickers sync | Daily 06:30 |
| IBKR Flex + Banxico FIX sync | Daily 06:45 |
| Daily balance push | Daily 07:00 |
| Card cut-off/payment push | Daily 07:05 |
| Patrimonio Precierre checklist | Last calendar day 18:00 |
| Previous-month close email | Day 1, 07:10 |

Manual refresh uses POST /wealth/sync/bitso or /ibkr. `BitsoApiSecretArn` stores apiKey/apiSecret/owner; `IbkrApiSecretArn` stores flexToken/flexQueryId/banxicoToken/owner. Configure read-only provider access; placeholders pending are not working credentials. Scheduler jobs have native retry/DLQ/alarms. Review actual stack definitions when changing schedules or credentials.

Monthly mail stores immutable prepared HTML/text/hash/facts and separate SES receipt; retry reuses prepared content and skips recorded sends. SES acceptance before receipt storage may duplicate a send. AI failure falls back to deterministic analysis. Report profile/voice comes from the active private prompt; [assistant](ai-assistant.md#prompt-management) owns its preservation/promotion rules. No verification should send real notifications or commit financial test records.

#!/usr/bin/env bash
set -euo pipefail

# Called only by deploy-production, after CloudFormation finishes. Never release
# code, change authority or mutate DynamoDB here. Current catalog, financial and
# rollback gates precede the reviewed removal of retired SQL migration tables.
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
operator_function="$(aws cloudformation describe-stacks --stack-name PersonalFinanceV1 \
  --query "Stacks[0].Outputs[?OutputKey=='DsqlCutoverFunction'].OutputValue | [0]" --output text)"
[[ -n "$operator_function" && "$operator_function" != 'None' ]] || { echo 'SQL authority operator output missing' >&2; exit 1; }
response_file="$(mktemp)"
metadata_file="$(mktemp)"
trap 'rm -f "$response_file" "$metadata_file"' EXIT
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
aws lambda invoke --function-name "$operator_function" --cli-binary-format raw-in-base64-out \
  --payload '{"action":"status"}' --cli-read-timeout 180 "$response_file" > "$metadata_file"
jq -e '.StatusCode == 200 and .FunctionError == null' "$metadata_file" > /dev/null || { echo 'SQL authority check failed' >&2; exit 1; }
jq -e '.mode == "sql"' "$response_file" > /dev/null || { echo 'Expected SQL authority; routine deployment cannot perform a cutover' >&2; exit 1; }
echo 'SQL authority confirmed'
machine_arn="$(aws cloudformation describe-stacks --stack-name PersonalFinanceV1 \
  --query "Stacks[0].Outputs[?OutputKey=='DsqlReconciliationArn'].OutputValue | [0]" --output text)"
if [[ -z "$machine_arn" || "$machine_arn" == 'None' ]]; then
  echo 'DSQL reconciliation output is missing' >&2
  exit 1
fi
execution_arn="$(aws stepfunctions start-execution --state-machine-arn "$machine_arn" \
  --name "deploy-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-sql" --input '{}' --query executionArn --output text)"
echo "DSQL reconciliation execution: $execution_arn"
deadline=$((SECONDS + 3000))
while (( SECONDS < deadline )); do
  status="$(aws stepfunctions describe-execution --execution-arn "$execution_arn" --query status --output text)"
  case "$status" in
    SUCCEEDED)
      aws stepfunctions describe-execution --execution-arn "$execution_arn" --query '{status:status,startDate:startDate,stopDate:stopDate}' --output json
      # Aggregates in the private execution report include David's finances.
      # Publish only verification counters to the public repository's Actions log.
      aws stepfunctions describe-execution --execution-arn "$execution_arn" --query output --output text | \
        jq '{phase,projected,equal,lag,mismatch}'
      # Read-only deployed probe: compare actual public feeds, details and monthly
      # calculations, then report counts/timings/native DPU estimates only.
      aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
      reader_function="$(aws cloudformation describe-stacks --stack-name PersonalFinanceV1 \
        --query "Stacks[0].Outputs[?OutputKey=='DsqlReadVerificationFunction'].OutputValue | [0]" --output text)"
      [[ -n "$reader_function" && "$reader_function" != 'None' ]] || { echo 'Read verification output missing' >&2; exit 1; }
      aws lambda invoke --function-name "$reader_function" --cli-binary-format raw-in-base64-out \
        --payload '{}' --cli-read-timeout 900 "$response_file" > "$metadata_file"
      jq -e '.StatusCode == 200 and .FunctionError == null' "$metadata_file" > /dev/null || { echo 'Read verification invocation failed' >&2; exit 1; }
      cat "$response_file"
      jq -e '.verified == true and .mode == "native-sql" and .mismatches == 0 and .provenance.mismatches == 0 and .evidence.mismatches == 0' "$response_file" > /dev/null || { echo 'Public read equivalence failed' >&2; exit 1; }
      aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
      aws lambda invoke --function-name "$operator_function" --cli-binary-format raw-in-base64-out \
        --payload '{"action":"smoke"}' --cli-read-timeout 180 "$response_file" > "$metadata_file"
      jq -e '.StatusCode == 200 and .FunctionError == null' "$metadata_file" > /dev/null || { echo 'Native SQL write smoke failed' >&2; exit 1; }
      jq -e '.verified == true and .rolledBack == true and .nativeLedger == true and .nativeWealth == true and .nativePush == true and .nativeDeliveries == true and .nativeThreads == true and .nativeExceptions == true' "$response_file" > /dev/null || { echo 'Native SQL rollback verification failed' >&2; exit 1; }
      cat "$response_file"
      # Destructive schema cleanup belongs exclusively to this reviewed deployment,
      # after every updated native reader and writer has passed its real gate.
      aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
      schema_function="$(aws cloudformation describe-stacks --stack-name PersonalFinanceV1 \
        --query "Stacks[0].Outputs[?OutputKey=='DsqlSchemaFunction'].OutputValue | [0]" --output text)"
      [[ -n "$schema_function" && "$schema_function" != 'None' ]] || { echo 'Schema cleanup output missing' >&2; exit 1; }
      aws lambda invoke --function-name "$schema_function" --cli-binary-format raw-in-base64-out \
        --payload '{"action":"retire-migration-evidence"}' --cli-read-timeout 900 "$response_file" > "$metadata_file"
      jq -e '.StatusCode == 200 and .FunctionError == null' "$metadata_file" > /dev/null || { echo 'SQL catalog cleanup invocation failed' >&2; exit 1; }
      jq -e '.verified == true and .mode == "native-sql" and .remainingTables == 41 and .domainTables == 38 and .controlTables == 3 and .migrationEvidenceTables == 0
        and (.removedTables | type) == "number" and .removedTables >= 0 and .removedTables <= 26
        and (.removedTables | floor) == .removedTables' "$response_file" > /dev/null || { echo 'SQL catalog cleanup failed' >&2; exit 1; }
      cat "$response_file"
      # Every release has already passed the complete independent financial,
      # original-evidence and rollback gates. Repeat them only if retirement
      # actually changed the catalog; a malformed cleanup proof fails above.
      if jq -e '.removedTables == 0' "$response_file" > /dev/null; then
        echo 'Native catalog unchanged; complete financial, evidence and rollback gates passed'
        exit 0
      fi
      # Re-run current finances and original-object checks against the clean catalog.
      aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
      aws lambda invoke --function-name "$reader_function" --cli-binary-format raw-in-base64-out \
        --payload '{}' --cli-read-timeout 900 "$response_file" > "$metadata_file"
      jq -e '.StatusCode == 200 and .FunctionError == null' "$metadata_file" > /dev/null || { echo 'Clean SQL read verification invocation failed' >&2; exit 1; }
      jq -e '.verified == true and .mode == "native-sql" and .mismatches == 0 and .provenance.mismatches == 0 and .evidence.mismatches == 0' "$response_file" > /dev/null || { echo 'Clean SQL financial verification failed' >&2; exit 1; }
      cat "$response_file"
      aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
      aws lambda invoke --function-name "$operator_function" --cli-binary-format raw-in-base64-out \
        --payload '{"action":"smoke"}' --cli-read-timeout 180 "$response_file" > "$metadata_file"
      jq -e '.StatusCode == 200 and .FunctionError == null' "$metadata_file" > /dev/null || { echo 'Clean SQL write smoke invocation failed' >&2; exit 1; }
      jq -e '.verified == true and .rolledBack == true and .nativeLedger == true and .nativeWealth == true and .nativePush == true and .nativeDeliveries == true and .nativeThreads == true and .nativeExceptions == true' "$response_file" > /dev/null || { echo 'Clean SQL rollback verification failed' >&2; exit 1; }
      cat "$response_file"
      exit 0 ;;
    FAILED|TIMED_OUT|ABORTED)
      aws stepfunctions describe-execution --execution-arn "$execution_arn" --query '{status:status,error:error,cause:cause}' --output json
      exit 1 ;;
    RUNNING) sleep 15 ;;
    *) echo "Unexpected reconciliation status: $status" >&2; exit 1 ;;
  esac
done
echo "DSQL verification timed out; inspect the retained execution: $execution_arn" >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

# Called only by deploy-production, after CloudFormation finishes. Never release
# code, change authority or mutate DynamoDB here. SQL maintenance verifies retained
# recovery envelopes; the native financial probe verifies current relational authority.
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
      jq -e '.verified == true and .rolledBack == true and .nativeLedger == true and .nativeWealth == true and .nativePush == true and .nativeDeliveries == true and .nativeThreads == true' "$response_file" > /dev/null || { echo 'Native SQL rollback verification failed' >&2; exit 1; }
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

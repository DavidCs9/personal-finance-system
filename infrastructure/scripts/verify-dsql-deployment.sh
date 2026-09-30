#!/usr/bin/env bash
set -euo pipefail

# Called only by deploy-production, after CloudFormation finishes. Never release
# code or mutate DynamoDB here. The deployed state machine owns all projection work.
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
machine_arn="$(aws cloudformation describe-stacks --stack-name PersonalFinanceV1 \
  --query "Stacks[0].Outputs[?OutputKey=='DsqlReconciliationArn'].OutputValue | [0]" --output text)"
if [[ -z "$machine_arn" || "$machine_arn" == 'None' ]]; then
  echo 'DSQL reconciliation output is missing' >&2
  exit 1
fi
execution_arn="$(aws stepfunctions start-execution --state-machine-arn "$machine_arn" \
  --name "deploy-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}" --input '{}' --query executionArn --output text)"
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

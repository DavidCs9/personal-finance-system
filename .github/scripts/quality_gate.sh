#!/usr/bin/env bash
set -euo pipefail

[[ "${SCOPE_RESULT:?}" == success ]] || { echo 'Change scope failed or was cancelled' >&2; exit 1; }
if [[ "${DOCS_ONLY:?}" == true ]]; then
  expected=skipped
elif [[ "$DOCS_ONLY" == false ]]; then
  expected=success
else
  echo 'Missing or invalid change-scope proof' >&2
  exit 1
fi
for result in "${FAST_RESULT:?}" "${TEST_RESULT:?}" "${BUILD_RESULT:?}"; do
  [[ "$result" == "$expected" ]] || { echo "Required validation did not finish: $result (expected $expected)" >&2; exit 1; }
done
echo 'All required validation passed'

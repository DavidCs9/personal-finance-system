#!/usr/bin/env bash
set -euo pipefail

# npm runs workspace scripts sequentially. These independent typechecks share
# no output; use native workspace discovery and bounded runner CPU concurrency.
workers=$(getconf _NPROCESSORS_ONLN)
if (( workers > 4 )); then workers=4; fi
npm query .workspace \
  | jq -je '.[] | select(.scripts.check | type == "string" and length > 0) | .name + "\u0000"' \
  | xargs -0 -r -n1 -P "$workers" npm run check --workspace

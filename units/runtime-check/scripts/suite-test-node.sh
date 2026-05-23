#!/usr/bin/env bash
# Shared node CLI test for a runtime-check library suite.
# Usage: scripts/suite-test-node.sh <suite>
set -euo pipefail

SUITE="${1:?suite name required (e.g. formidable, qs)}"
RUNTIME_CHECK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUITE_DIR="$RUNTIME_CHECK_ROOT/packages/$SUITE"

if [[ ! -d "$SUITE_DIR" ]]; then
  echo "FATAL: unknown suite directory: $SUITE_DIR"
  exit 1
fi

# shellcheck source=suite-tee-terminal.sh
source "$RUNTIME_CHECK_ROOT/scripts/suite-tee-terminal.sh" "$SUITE_DIR" node

cd "$RUNTIME_CHECK_ROOT"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  npm ci --silent 2>&1
  npm run build
fi
node "$RUNTIME_CHECK_ROOT/scripts/suite-run-node.mjs" "$SUITE"

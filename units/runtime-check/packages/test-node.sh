#!/usr/bin/env bash
# Run node CLI tests for every package under packages/ (dirs with index.ts).
#
# Usage:
#   ./units/runtime-check/packages/test-node.sh
#   SKIP_BUILD=1 ./units/runtime-check/packages/test-node.sh
set -euo pipefail

PACKAGES_ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CHECK_ROOT="$(cd "$PACKAGES_ROOT/.." && pwd)"

discover_suites() {
  local name
  for dir in "$PACKAGES_ROOT"/*/; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    [[ -f "$dir/index.ts" ]] || continue
    printf '%s\n' "$name"
  done | sort
}

SUITES=()
while IFS= read -r suite; do
  SUITES+=("$suite")
done < <(discover_suites)
if [[ ${#SUITES[@]} -eq 0 ]]; then
  echo "FATAL: no package suites found (expected packages/<name>/index.ts)"
  exit 1
fi

echo "==> Package suites (${#SUITES[@]}): ${SUITES[*]}"
echo ""

FAILED=()
BUILT=0
for suite in "${SUITES[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "==> [packages] node: $suite"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if (( BUILT )); then
    if ! SKIP_BUILD=1 "$RUNTIME_CHECK_ROOT/scripts/suite-test-node.sh" "$suite"; then
      FAILED+=("$suite")
    fi
  else
    if ! "$RUNTIME_CHECK_ROOT/scripts/suite-test-node.sh" "$suite"; then
      FAILED+=("$suite")
    fi
    BUILT=1
  fi
  echo ""
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED packages (node): ${FAILED[*]}"
  exit 1
fi

echo "==> All package node tests passed (${#SUITES[@]}/${#SUITES[@]})"

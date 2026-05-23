#!/usr/bin/env bash
# Tee full stdout/stderr into packages/<suite>/.last-terminal.<mode>.txt
# Usage: source scripts/suite-tee-terminal.sh <suite-dir> <node|platform>
set -euo pipefail
SUITE_DIR="${1:?suite directory required}"
RUN_MODE="${2:?run mode required (node or platform)}"
if [[ "$RUN_MODE" != "node" && "$RUN_MODE" != "platform" ]]; then
  echo "FATAL: run mode must be 'node' or 'platform', got: $RUN_MODE"
  exit 1
fi
TERMINAL_LOG="$SUITE_DIR/.last-terminal.${RUN_MODE}.txt"
: > "$TERMINAL_LOG"
exec > >(tee -a "$TERMINAL_LOG") 2>&1

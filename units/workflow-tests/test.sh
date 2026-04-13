#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Workflow integration tests
#
# Expects Redis and NATS from compose.yml to be running.
# Compiles the TypeScript workflow units, runs the test_workflow binary, and
# writes the JSON report to .output.log — same pattern as runtime-check.
#
# Usage:
#   ./units/workflow-tests/test.sh                         # from project root
#   SKIP_BUILD=1 ./units/workflow-tests/test.sh            # skip cargo/npm build
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_FILE="$SCRIPT_DIR/.output.log"

WF_REDIS_URL="redis://127.0.0.1:6379"
WF_NATS_URL="nats://runtime_nats:z2TBGYR8dF1uX2@127.0.0.1:4222"

# ------------------------------------------------------------------
# 0. Check compose.yml services are running
# ------------------------------------------------------------------
echo "==> Checking compose.yml services…"

if ! nc -z 127.0.0.1 6379 2>/dev/null; then
  echo "ERROR: Nothing is listening on port 6379 (Redis)."
  echo "       Run 'docker compose up -d' from the project root first."
  exit 1
fi
echo "    Redis ✓"

if ! nc -z 127.0.0.1 4222 2>/dev/null; then
  echo "ERROR: NATS is not running on port 4222."
  echo "       Run 'docker compose up -d' from the project root first."
  exit 1
fi
echo "    NATS  ✓"

# ------------------------------------------------------------------
# 1. Build
# ------------------------------------------------------------------
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> Installing npm deps…"
  cd "$SCRIPT_DIR"
  npm ci --silent 2>&1

  echo "==> Compiling TypeScript → dist/…"
  npx tsc --noEmit false --outDir dist --sourceMap false --declaration false \
    --noUnusedLocals false --noUnusedParameters false
  echo "    dist/ ready ($(find dist -name '*.js' | wc -l | tr -d ' ') JS files)"

  echo "==> Building test_workflow binary (release)…"
  cd "$PROJECT_ROOT"
  cargo build --bin test_workflow --release 2>&1
else
  echo "==> Skipping build (SKIP_BUILD=1)"
fi

# ------------------------------------------------------------------
# 2. Run tests
# ------------------------------------------------------------------
echo ""
echo "==> Running workflow tests…"
TEST_EXIT=0
WF_REDIS_URL="$WF_REDIS_URL" \
WF_NATS_URL="$WF_NATS_URL" \
WORKFLOW_DIST="$SCRIPT_DIR/dist" \
  "$PROJECT_ROOT/target/release/test_workflow" > "$OUTPUT_FILE" || TEST_EXIT=$?

echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"
echo ""

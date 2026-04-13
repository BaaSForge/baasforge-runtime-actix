#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Workflow integration tests
#
# Compiles the TypeScript workflow units, spins up a disposable Redis via
# Docker, runs the test_workflow binary, and writes the JSON report to
# .output.log — same pattern as units/runtime-check/test.sh.
#
# Usage:
#   ./units/workflow-tests/test.sh                         # from project root
#   SKIP_BUILD=1 ./units/workflow-tests/test.sh            # skip cargo/npm build
#   REDIS_PORT=16380 ./units/workflow-tests/test.sh        # custom Redis port
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REDIS_PORT="${REDIS_PORT:-16379}"
REDIS_CONTAINER="baal-wf-test-redis"
WF_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
OUTPUT_FILE="$SCRIPT_DIR/.output.log"

cleanup() {
  echo "==> Stopping Redis container…"
  docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ------------------------------------------------------------------
# 1. Start Redis
# ------------------------------------------------------------------
echo "==> Starting disposable Redis on port ${REDIS_PORT}…"
docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
docker run --rm -d \
  -p "${REDIS_PORT}:6379" \
  --name "$REDIS_CONTAINER" \
  redis:7-alpine >/dev/null

# Wait for Redis to be ready
for _ in $(seq 1 30); do
  if redis-cli -p "$REDIS_PORT" PING 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 0.3
done
echo "    Redis ready"

# ------------------------------------------------------------------
# 2. Build
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
# 3. Run tests
# ------------------------------------------------------------------
echo ""
echo "==> Running workflow tests…"
# Binary writes JSON report to stdout, progress to stderr.
# Capture stdout (JSON) to .output.log, let stderr flow to terminal.
TEST_EXIT=0
WF_REDIS_URL="$WF_REDIS_URL" \
WORKFLOW_DIST="$SCRIPT_DIR/dist" \
  "$PROJECT_ROOT/target/release/test_workflow" > "$OUTPUT_FILE" || TEST_EXIT=$?

echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"
echo ""
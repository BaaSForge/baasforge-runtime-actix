#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Queue Worker integration tests (end-to-end)
#
# Builds the TypeScript queue-worker units + test runner, starts the **real**
# application server in TEST_MODE, seeds all queue-worker units + the API test
# runner into the database, hits the trigger URL, and prints the report.
#
# Requires:
#   - docker compose up -d   (Redis, NATS, Postgres)
#   - .env / .env.local with valid DATABASE_URL
#
# Usage:
#   ./units/queue-worker-tests/test.sh
#   TEST_PORT=4445 ./units/queue-worker-tests/test.sh
#   SKIP_BUILD=1 ./units/queue-worker-tests/test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${TEST_PORT:-3335}"
OUTPUT_FILE="$SCRIPT_DIR/.output.log"
TEST_TIMEOUT="${TEST_TIMEOUT:-300}"
TERMINAL_LOG="$SCRIPT_DIR/test.terminal.log"
: > "$TERMINAL_LOG"
exec > >(tee -a "$TERMINAL_LOG") 2>&1

# ------------------------------------------------------------------
# Node.js version check — ws-tests.mjs requires Node 22 (global WebSocket).
# ------------------------------------------------------------------
NODE_VERSION="$(node --version 2>/dev/null || echo "not found")"
if [[ "$NODE_VERSION" != v22.* ]]; then
  echo "ERROR: Node.js 22 is required for ws-tests.mjs (current: ${NODE_VERSION})."
  echo "       Switch with: nvm use 22"
  exit 1
fi

TEST_PROJECT_ID="00000000-aaaa-bbbb-cccc-000000000010"
QW_BASE="/api/v1/trigger/workerQueue/${TEST_PROJECT_ID}/test/queue-worker"
TEST_RUNNER_URL="http://127.0.0.1:${PORT}/api/v1/trigger/${TEST_PROJECT_ID}/test/queue-worker-tests/index"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------
# 1. Build
# ------------------------------------------------------------------
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> Installing npm deps…"
  cd "$SCRIPT_DIR"
  npm ci --silent 2>&1

  echo "==> Compiling TypeScript -> dist/…"
  npx tsc --noEmit false --outDir dist --sourceMap false --declaration false \
    --noUnusedLocals false --noUnusedParameters false
  echo "    dist/ ready ($(find dist -name '*.js' | wc -l | tr -d ' ') JS files)"

  echo "==> Building main server binary (release)…"
  cd "$PROJECT_ROOT"
  cargo build --release 2>&1
else
  echo "==> Skipping build (SKIP_BUILD=1)"
fi

# ------------------------------------------------------------------
# 2. Start the real server in TEST_MODE
# ------------------------------------------------------------------
echo "==> Starting server on port ${PORT} (TEST_MODE)…"

TEST_MODE=1 \
APP_ENV=production \
PORT="$PORT" \
TEST_UNIT_FILES="queue-worker-tests=$SCRIPT_DIR/dist/index.js" \
TEST_QUEUE_WORKER_DIR="$SCRIPT_DIR/dist" \
TEST_WORKFLOW_DIR="$SCRIPT_DIR/dist/cross-unit" \
  "$PROJECT_ROOT/target/release/baal-runtime-actix" &
SERVER_PID=$!

echo "==> Waiting for server to be ready…"
for _ in $(seq 1 60); do
  if curl -s --max-time 1 "http://127.0.0.1:${PORT}/" -o /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "FATAL: server exited unexpectedly"
  exit 1
fi
echo "    server ready (pid $SERVER_PID)"

echo ""
echo "  TEST RUNNER URL: $TEST_RUNNER_URL"
echo ""

# ------------------------------------------------------------------
# 3. Run queue worker endpoint + behavioral tests
# ------------------------------------------------------------------
echo "==> Running queue worker tests (timeout ${TEST_TIMEOUT}s)…"
QW_OUTPUT="$SCRIPT_DIR/.qw-output.tmp.json"
curl -s --max-time "$TEST_TIMEOUT" "$TEST_RUNNER_URL" > "$QW_OUTPUT"

# ------------------------------------------------------------------
# 4. Run WebSocket tests (Node.js, outside the QuickJS runtime)
# ------------------------------------------------------------------
echo "==> Running WebSocket tests…"
WS_OUTPUT="$SCRIPT_DIR/.ws-output.tmp.json"
node "$SCRIPT_DIR/ws-tests.mjs" "http://127.0.0.1:${PORT}" > "$WS_OUTPUT"

# ------------------------------------------------------------------
# 5. Merge queue-worker report + WebSocket report → .output.log
# ------------------------------------------------------------------
echo "==> Merging reports…"
echo "    (queue worker) $(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$QW_OUTPUT" | tr -d '\n')"
echo "    (WebSocket)    $(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$WS_OUTPUT" | tr -d '\n')"
node "$PROJECT_ROOT/units/merge-test-reports.mjs" "$QW_OUTPUT" "$WS_OUTPUT" "$OUTPUT_FILE"
rm -f "$QW_OUTPUT" "$WS_OUTPUT"

echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"
echo ""

SUMMARY=$(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$OUTPUT_FILE" | tr -d '\n')
echo "==> Combined: ${SUMMARY} [queue worker + WebSocket]"

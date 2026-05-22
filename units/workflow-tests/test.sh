#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Workflow integration tests (end-to-end)
#
# Builds workflow TypeScript plus in-repo seed copies for homonymous-path
# actor/queue-worker fixtures, starts the **real** application server in
# TEST_MODE, seeds units + the API test runner, hits the trigger URL, and
# prints the report.
#
# Requires:
#   - docker compose up -d   (Redis, NATS, Postgres)
#   - .env / .env.local with valid DATABASE_URL
#
# Usage:
#   ./units/workflow-tests/test.sh
#   TEST_PORT=4444 ./units/workflow-tests/test.sh
#   SKIP_BUILD=1 ./units/workflow-tests/test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../test-server-lib.sh
source "$SCRIPT_DIR/../test-server-lib.sh"
PORT="${TEST_PORT:-3334}"
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
TRIGGER_PATH="/api/v1/trigger/${TEST_PROJECT_ID}/test/wf/test"
BASE_URL="http://127.0.0.1:${PORT}${TRIGGER_PATH}"

SERVER_PID=""
CLEANED_UP=0
cleanup() {
  if (( CLEANED_UP != 0 )); then
    return 0
  fi
  CLEANED_UP=1
  stop_test_server "$SERVER_PID" "$PORT"
  SERVER_PID=""
}
trap cleanup EXIT INT TERM

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
free_listen_port "$PORT"
echo "==> Starting server on port ${PORT} (TEST_MODE)…"
TEST_MODE=1 \
APP_ENV=production \
PORT="$PORT" \
TEST_UNIT_FILES="workflow-tests=$SCRIPT_DIR/dist/index.js" \
TEST_WORKFLOW_DIR="$SCRIPT_DIR/dist" \
TEST_ACTOR_DIR="$SCRIPT_DIR/dist/seed-actors" \
TEST_QUEUE_WORKER_DIR="$SCRIPT_DIR/dist/seed-queue-workers" \
  "$PROJECT_ROOT/target/release/baal-runtime-actix" &
SERVER_PID=$!

echo "==> Waiting for server to be ready…"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/trigger/${TEST_PROJECT_ID}/test/wf/test" >/dev/null 2>&1; then
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
echo "  TRIGGER URL: $BASE_URL"
echo ""

# ------------------------------------------------------------------
# 3–4. QuickJS workflow suite + WebSocket tests (parallel jobs)
# ------------------------------------------------------------------
echo "==> Running workflow trigger + WebSocket tests in parallel (timeout ${TEST_TIMEOUT}s for curl)…"
WF_OUTPUT="$SCRIPT_DIR/.wf-output.tmp.json"
WS_OUTPUT="$SCRIPT_DIR/.ws-output.tmp.json"
curl -s --max-time "$TEST_TIMEOUT" "$BASE_URL" >"$WF_OUTPUT" &
curl_pid=$!
node "$SCRIPT_DIR/ws-tests.mjs" "http://127.0.0.1:${PORT}" >"$WS_OUTPUT" &
ws_pid=$!
fail=0
wait $curl_pid || fail=1
wait $ws_pid || fail=1
if (( fail != 0 )); then
  echo "ERROR: workflow curl and/or WebSocket job failed" >&2
  exit 1
fi

# ------------------------------------------------------------------
# 5. Merge parallel job reports → .output.log
# ------------------------------------------------------------------
echo "==> Merging reports…"
echo "    (workflows)   $(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$WF_OUTPUT" | tr -d '\n')"
echo "    (WebSocket)   $(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$WS_OUTPUT" | tr -d '\n')"
node "$PROJECT_ROOT/units/merge-test-reports.mjs" "$WF_OUTPUT" "$WS_OUTPUT" "$OUTPUT_FILE"
rm -f "$WF_OUTPUT" "$WS_OUTPUT"

echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"
echo ""

SUMMARY=$(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$OUTPUT_FILE" | tr -d '\n')
echo "==> Combined: ${SUMMARY} [workflows + WebSocket]"

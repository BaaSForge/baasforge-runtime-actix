#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Actor integration tests (end-to-end)
#
# Builds the TypeScript actor units + test runner (including in-tree
# seed-workflows / seed-queue-workers copies for homonymous-path isolation),
# starts the **real** application server in TEST_MODE, seeds units + API
# runner, hits the trigger URL, and prints the report.
#
# Requires:
#   - docker compose up -d   (Redis, NATS, Postgres, Actor Redis, Actor NATS, Actor PG)
#   - .env / .env.local with valid DATABASE_URL, ACTOR_DATABASE_URL, ACTOR_REDIS_URL, ACTOR_NATS_URL
#
# Usage:
#   ./units/actor-tests/test.sh
#   TEST_PORT=4445 ./units/actor-tests/test.sh
#   SKIP_BUILD=1 ./units/actor-tests/test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../test-server-lib.sh
source "$SCRIPT_DIR/../test-server-lib.sh"
PORT="${TEST_PORT:-3335}"
OUTPUT_FILE="$SCRIPT_DIR/.output.log"
TEST_TIMEOUT="${TEST_TIMEOUT:-600}"
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
TEST_RUNNER_URL="http://127.0.0.1:${PORT}/api/v1/trigger/${TEST_PROJECT_ID}/test/actor-tests/index"

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
  if [[ ! -f package-lock.json ]]; then
    npm install 2>&1
  else
    npm ci 2>&1
  fi

  echo "==> Compiling TypeScript -> dist/…"
  npx tsc --noEmit false --outDir dist --sourceMap false --declaration false \
    --noUnusedLocals false --noUnusedParameters false
  echo "    dist/ ready ($(find dist -name '*.js' | wc -l | tr -d ' ') JS files)"

  maybe_build_server_binary "$PROJECT_ROOT"
else
  echo "==> Skipping build (SKIP_BUILD=1)"
fi

if [[ ! -d "$SCRIPT_DIR/dist/seed-workflows" || ! -d "$SCRIPT_DIR/dist/seed-queue-workers" ]]; then
  echo "FATAL: $SCRIPT_DIR/dist/seed-workflows or .../seed-queue-workers missing (run tsc on actor-tests or omit SKIP_BUILD=1)"
  exit 1
fi

# ------------------------------------------------------------------
# 2. Start the real server in TEST_MODE
# ------------------------------------------------------------------
free_listen_port "$PORT"
echo "==> Starting server on port ${PORT} (TEST_MODE, DB pools ${TEST_DATABASE_POOL_SIZE:-20}, actor-test concurrency ${ACTOR_TEST_RUNNER_CONCURRENCY:-4})…"

TEST_MODE=1 \
APP_ENV=production \
PORT="$PORT" \
DATABASE_POOL_SIZE="${TEST_DATABASE_POOL_SIZE:-20}" \
ACTOR_DATABASE_POOL_SIZE="${TEST_ACTOR_DATABASE_POOL_SIZE:-20}" \
ACTOR_TEST_RUNNER_CONCURRENCY="${ACTOR_TEST_RUNNER_CONCURRENCY:-4}" \
ACTOR_IDLE_SWEEP_SECS=1 \
TEST_UNIT_FILES="actor-tests=$SCRIPT_DIR/dist/index.js" \
TEST_ACTOR_DIR="$SCRIPT_DIR/dist" \
TEST_WORKFLOW_DIR="$SCRIPT_DIR/dist/seed-workflows" \
TEST_QUEUE_WORKER_DIR="$SCRIPT_DIR/dist/seed-queue-workers" \
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
# 3–4. QuickJS actor suite, then WebSocket tests (sequential — WS load
#     starves the alarm sweeper and causes false alarm-loss failures)
# ------------------------------------------------------------------
echo "==> Running actor trigger (timeout ${TEST_TIMEOUT}s)…"
ACTOR_OUTPUT="$SCRIPT_DIR/.actor-output.tmp.json"
WS_OUTPUT="$SCRIPT_DIR/.ws-output.tmp.json"
if ! curl -s --max-time "$TEST_TIMEOUT" "$TEST_RUNNER_URL" >"$ACTOR_OUTPUT"; then
  echo "ERROR: actor trigger failed" >&2
  exit 1
fi
echo "==> Running WebSocket tests…"
if ! node "$SCRIPT_DIR/ws-tests.mjs" "http://127.0.0.1:${PORT}" >"$WS_OUTPUT"; then
  echo "ERROR: WebSocket tests failed" >&2
  exit 1
fi

# ------------------------------------------------------------------
# 5. Merge parallel job reports → .output.log
# ------------------------------------------------------------------
echo "==> Merging reports…"
echo "    (trigger/QuickJS) $(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$ACTOR_OUTPUT" | tr -d '\n')"
echo "    (WebSocket)       $(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$WS_OUTPUT" | tr -d '\n')"
node "$PROJECT_ROOT/units/merge-test-reports.mjs" "$ACTOR_OUTPUT" "$WS_OUTPUT" "$OUTPUT_FILE"
rm -f "$ACTOR_OUTPUT" "$WS_OUTPUT"

echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"
echo ""

SUMMARY=$(node "$PROJECT_ROOT/units/report-summary-line.mjs" "$OUTPUT_FILE" | tr -d '\n')
echo "==> Combined: ${SUMMARY} [trigger + WebSocket]"

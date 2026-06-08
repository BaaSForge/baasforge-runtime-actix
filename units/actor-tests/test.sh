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
#   ACTOR_TEST_CASE_TIMEOUT_SEC=60   per-test case limit (default 60s, starts when each test begins)
#   ACTOR_TEST_INJECT_HANG=state-init  debug: make one test sleep 120s to verify per-test timeout
#   ACTOR_TEST_DEBUG=1               enable all debug (fetch trace, heartbeat, runtime_trace logs)
#   ACTOR_TEST_HEARTBEAT_SEC=30      in-runner heartbeat interval (0=off)
#   ACTOR_TEST_DEBUG_FETCH=1         log every fetch start/end (very verbose)
#   RUST_LOG=runtime_trace=info,...  server-side invoke/heartbeat traces
#   TEST_DATABASE_POOL_SIZE=20       override prod .env pool (default 3 starves parallel tests)
#   ACTOR_TEST_RUNNER_CONCURRENCY=4  parallel inline/actor jobs (8 × pool-3 deadlocks on CI)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../test-server-lib.sh
source "$SCRIPT_DIR/../test-server-lib.sh"
PORT="${TEST_PORT:-3335}"
OUTPUT_FILE="$SCRIPT_DIR/.output.log"
ACTOR_TEST_CASE_TIMEOUT_SEC="${ACTOR_TEST_CASE_TIMEOUT_SEC:-60}"
export ACTOR_TEST_CASE_TIMEOUT_MS=$((ACTOR_TEST_CASE_TIMEOUT_SEC * 1000))
TEST_TIMEOUT="${TEST_TIMEOUT:-900}"
TERMINAL_LOG="$SCRIPT_DIR/test.terminal.log"
: > "$TERMINAL_LOG"
exec > >(tee -a "$TERMINAL_LOG") 2>&1

if [[ "${ACTOR_TEST_DEBUG:-}" == "1" ]]; then
  export ACTOR_TEST_DEBUG_FETCH=1
  export ACTOR_TEST_HEARTBEAT_SEC="${ACTOR_TEST_HEARTBEAT_SEC:-30}"
  export RUST_LOG="${RUST_LOG:-runtime_trace=info,baal_runtime_actix=info}"
  echo "==> ACTOR_TEST_DEBUG=1 (fetch trace, heartbeat=${ACTOR_TEST_HEARTBEAT_SEC}s, RUST_LOG=${RUST_LOG})"
fi

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
echo "==> Starting server on port ${PORT} (TEST_MODE, DB pools ${TEST_DATABASE_POOL_SIZE:-20}, concurrency ${ACTOR_TEST_RUNNER_CONCURRENCY:-4})…"

if [[ -n "${ACTOR_TEST_INJECT_HANG:-}" ]]; then
  export ACTOR_TEST_INJECT_HANG
fi

TEST_MODE=1 \
RUST_LOG="${RUST_LOG:-runtime_trace=info,baal_runtime_actix=info}" \
APP_ENV=production \
PORT="$PORT" \
DATABASE_POOL_SIZE="${TEST_DATABASE_POOL_SIZE:-20}" \
ACTOR_DATABASE_POOL_SIZE="${TEST_ACTOR_DATABASE_POOL_SIZE:-20}" \
ACTOR_TEST_RUNNER_CONCURRENCY="${ACTOR_TEST_RUNNER_CONCURRENCY:-4}" \
ACTOR_TEST_CASE_TIMEOUT_MS="$ACTOR_TEST_CASE_TIMEOUT_MS" \
ACTOR_TEST_DEBUG_FETCH="${ACTOR_TEST_DEBUG_FETCH:-}" \
ACTOR_TEST_HEARTBEAT_SEC="${ACTOR_TEST_HEARTBEAT_SEC:-30}" \
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
echo "==> Running actor trigger (per-test timeout ${ACTOR_TEST_CASE_TIMEOUT_SEC}s, curl max ${TEST_TIMEOUT}s)…"
ACTOR_OUTPUT="$SCRIPT_DIR/.actor-output.tmp.json"
WS_OUTPUT="$SCRIPT_DIR/.ws-output.tmp.json"

list_in_progress_actor_tests() {
  grep -E 'actor: .+ …$' "$TERMINAL_LOG" 2>/dev/null | while read -r line; do
    label="${line#  actor: }"
    label="${label% …}"
    if ! grep -qF "actor: ${label} ok" "$TERMINAL_LOG" 2>/dev/null \
      && ! grep -qF "actor: ${label} FAIL" "$TERMINAL_LOG" 2>/dev/null; then
      echo "      - ${label}"
    fi
  done
}

WATCHDOG_PID=""
start_curl_watchdog() {
  (
  while true; do
    sleep 30
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    echo "==> [watchdog $(date -Iseconds)] actor trigger still running…"
    inprog="$(list_in_progress_actor_tests || true)"
    if [[ -n "$inprog" ]]; then
      echo "$inprog"
    else
      echo "      (no in-progress actor: lines — check actor-heartbeat / runtime_trace logs)"
    fi
  done
  ) &
  WATCHDOG_PID=$!
}

stop_curl_watchdog() {
  if [[ -n "${WATCHDOG_PID:-}" ]]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    WATCHDOG_PID=""
  fi
}

start_curl_watchdog
if ! curl -s --max-time "$TEST_TIMEOUT" "$TEST_RUNNER_URL" >"$ACTOR_OUTPUT"; then
  stop_curl_watchdog
  echo "ERROR: actor trigger failed or curl timed out after ${TEST_TIMEOUT}s" >&2
  if [[ -s "$ACTOR_OUTPUT" ]]; then
    echo "    partial response:" >&2
    head -c 4000 "$ACTOR_OUTPUT" >&2 || true
    echo "" >&2
  fi
  echo "    timed-out / in-progress tests (last lines from server log):" >&2
  list_in_progress_actor_tests >&2 || true
  exit 1
fi
stop_curl_watchdog
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

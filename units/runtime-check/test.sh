#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Runtime-check integration test (end-to-end)
#
# Builds the TypeScript health-check unit, starts the **real** application
# server in TEST_MODE, seeds the unit into the database, hits the production
# trigger URL, and prints the response.
#
# Requires:
#   - docker compose up -d   (Redis, NATS, Postgres)
#   - .env / .env.local with valid DATABASE_URL
#
# Usage:
#   ./units/runtime-check/test.sh
#   TEST_PORT=4444 ./units/runtime-check/test.sh
#   SKIP_BUILD=1 ./units/runtime-check/test.sh
#   HEALTH_CHECK_TIMEOUT=180 ./units/runtime-check/test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${TEST_PORT:-3333}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-120}"

TEST_PROJECT_ID="00000000-aaaa-bbbb-cccc-000000000010"
TRIGGER_PATH="/api/v1/trigger/${TEST_PROJECT_ID}/test/runtime/check"
BASE_URL="http://127.0.0.1:${PORT}${TRIGGER_PATH}"

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
  echo "==> Installing npm deps & building TypeScript…"
  cd "$SCRIPT_DIR"
  npm ci --silent 2>&1
  npx tsc --noEmit false --outDir dist
  echo "    dist/index.js ready"

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
TEST_UNIT_FILES="runtime-check=$SCRIPT_DIR/dist/index.js" \
TEST_COMMON_DIR="$SCRIPT_DIR/dist/module-loader" \
  "$PROJECT_ROOT/target/release/baal-runtime-actix" &
SERVER_PID=$!

echo "==> Waiting for server to be ready…"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/trigger/${TEST_PROJECT_ID}/test/runtime/check?_t=json" >/dev/null 2>&1; then
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
# 3. Hit the trigger and write the response to file
# ------------------------------------------------------------------
OUTPUT_FILE="$SCRIPT_DIR/.output.log"
echo "==> Running trigger (timeout ${HEALTH_CHECK_TIMEOUT}s)…"
curl -s --max-time "$HEALTH_CHECK_TIMEOUT" "$BASE_URL" > "$OUTPUT_FILE"
echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"
echo ""

if command -v jq &>/dev/null; then
  PASSED=$(jq -r '.summary.total_passed'  "$OUTPUT_FILE" 2>/dev/null || echo "?")
  TOTAL=$(jq -r '.summary.total_tests'    "$OUTPUT_FILE" 2>/dev/null || echo "?")
  FAILED=$(jq -r '.summary.total_failed'  "$OUTPUT_FILE" 2>/dev/null || echo "?")
  echo "==> ${PASSED}/${TOTAL} passed, ${FAILED} failed"
fi

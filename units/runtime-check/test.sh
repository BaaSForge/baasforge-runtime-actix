#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Runtime-check integration test
#
# Builds the TypeScript health-check unit, starts a lightweight trigger server
# (no DB / Redis / NATS), hits the trigger URL, and prints the response.
#
# The trigger's index.js already runs all tests and produces a full report,
# so this script simply returns its HTTP output.
#
# Usage:
#   ./units/runtime-check/test.sh                        # from project root
#   TEST_PORT=4444 ./units/runtime-check/test.sh         # custom port
#   SKIP_BUILD=1 ./units/runtime-check/test.sh           # skip cargo/npm build
#   HEALTH_CHECK_TIMEOUT=180 ./units/runtime-check/test.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${TEST_PORT:-3333}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-120}"
TRIGGER_PATH="/api/v1/trigger/00000000-0000-0000-0000-000000000000/test/runtime/check"
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

  echo "==> Building test_trigger binary (release)…"
  cd "$PROJECT_ROOT"
  cargo build --bin test_trigger --release 2>&1
else
  echo "==> Skipping build (SKIP_BUILD=1)"
fi

# ------------------------------------------------------------------
# 2. Start the trigger server
# ------------------------------------------------------------------
echo "==> Starting trigger server on port ${PORT}…"
UNIT_JS_FILE="$SCRIPT_DIR/dist/index.js" PORT="$PORT" TRIGGER_PATH="$TRIGGER_PATH" \
  "$PROJECT_ROOT/target/release/test_trigger" &
SERVER_PID=$!

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/?_t=json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "FATAL: trigger server exited unexpectedly"
  exit 1
fi
echo "    server ready (pid $SERVER_PID)"

# ------------------------------------------------------------------
# 3. Hit the trigger and write the response to file
# ------------------------------------------------------------------
OUTPUT_FILE="$SCRIPT_DIR/.output.log"
echo ""
echo "==> Running trigger (timeout ${HEALTH_CHECK_TIMEOUT}s)…"
curl -s --max-time "$HEALTH_CHECK_TIMEOUT" "$BASE_URL" > "$OUTPUT_FILE"
echo "==> Done. Output written to:"
echo "    $OUTPUT_FILE"

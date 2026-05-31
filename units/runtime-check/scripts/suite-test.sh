#!/usr/bin/env bash
# Shared platform integration test for runtime-check library suites.
#
# Usage:
#   ./units/runtime-check/scripts/suite-test.sh qs
set -euo pipefail

SUITE="${1:?suite name required (e.g. qs)}"
RUNTIME_CHECK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUITE_DIR="$RUNTIME_CHECK_ROOT/packages/$SUITE"
SUITE_DIST="packages/$SUITE"
PROJECT_ROOT="$(cd "$RUNTIME_CHECK_ROOT/../.." && pwd)"
PORT="${TEST_PORT:-3333}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-120}"
TEST_PROJECT_ID="00000000-aaaa-bbbb-cccc-000000000010"
TRIGGER_URL="http://127.0.0.1:${PORT}/api/v1/trigger/${TEST_PROJECT_ID}/test/runtime/${SUITE}"
UNIT_LABEL="runtime-check-${SUITE}"

if [[ ! -d "$SUITE_DIR" ]]; then
  echo "FATAL: unknown suite directory: $SUITE_DIR"
  exit 1
fi

# shellcheck source=suite-tee-terminal.sh
source "$RUNTIME_CHECK_ROOT/scripts/suite-tee-terminal.sh" "$SUITE_DIR" platform

# shellcheck source=../../test-server-lib.sh
source "$RUNTIME_CHECK_ROOT/../test-server-lib.sh"

SERVER_PID=""
RAW_REPORT=""
cleanup() {
  rm -f "$RAW_REPORT"
  stop_test_server "$SERVER_PID" "$PORT"
  SERVER_PID=""
}
trap cleanup EXIT INT TERM

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> [$SUITE] Installing npm deps & building TypeScript…"
  cd "$RUNTIME_CHECK_ROOT"
  npm ci --silent 2>&1
  npm run build
  echo "    dist/$SUITE_DIST/index.js ready"

  echo "==> [$SUITE] Building main server binary (release)…"
  cd "$PROJECT_ROOT"
  cargo build --release 2>&1
else
  echo "==> [$SUITE] Skipping build (SKIP_BUILD=1)"
fi

free_listen_port "$PORT"
echo "==> [$SUITE] Starting server on port ${PORT} (TEST_MODE)…"
TEST_MODE=1 \
APP_ENV=production \
PORT="$PORT" \
TEST_UNIT_FILES="${UNIT_LABEL}=${RUNTIME_CHECK_ROOT}/dist/${SUITE_DIST}/index.js" \
  "$PROJECT_ROOT/target/release/baal-runtime-actix" &
SERVER_PID=$!

echo "==> [$SUITE] Waiting for server…"
for _ in $(seq 1 60); do
  if curl -sf "${TRIGGER_URL}" >/dev/null 2>&1; then
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
echo "  ${SUITE}: $TRIGGER_URL"
echo ""

echo "==> [$SUITE] Running trigger (timeout ${HEALTH_CHECK_TIMEOUT}s)…"
RAW_REPORT="$(mktemp "${TMPDIR:-/tmp}/runtime-check-${SUITE}.XXXXXX.json")"
curl -s --max-time "$HEALTH_CHECK_TIMEOUT" "$TRIGGER_URL" > "$RAW_REPORT"
if [[ -n "${SUITE_THROW_QUERY:-}" ]]; then
  echo "==> [$SUITE] Throw mapping test (${SUITE_THROW_QUERY})…"
  THROW_BODY="$(curl -s --max-time "$HEALTH_CHECK_TIMEOUT" "${TRIGGER_URL}${SUITE_THROW_QUERY}")"
  node -e "
const body = JSON.parse(process.argv[1]);
const expected = process.argv[2];
if (body.error !== expected) {
  console.error('expected { error: ' + JSON.stringify(expected) + ' }, got', body);
  process.exit(1);
}
console.log('    throw mapping OK:', JSON.stringify(body));
" "$THROW_BODY" "${SUITE_THROW_EXPECT:?SUITE_THROW_EXPECT required when SUITE_THROW_QUERY is set}"
fi
echo ""
node "$RUNTIME_CHECK_ROOT/scripts/suite-report.mjs" "$SUITE" "$RAW_REPORT" platform

#!/usr/bin/env bash
# Shared helpers for integration test scripts that bind a local HTTP port.

free_listen_port() {
  local port="$1"
  local pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "==> Freeing port ${port} (PIDs: ${pids//$'\n'/ })…"
  kill -TERM ${pids} 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    sleep 0.25
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
    [[ -z "$pids" ]] && return 0
  done
  kill -KILL ${pids} 2>/dev/null || true
  sleep 0.5
}

stop_test_server() {
  local pid="${1:-}"
  local port="$2"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 40); do
      if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" 2>/dev/null || true
        free_listen_port "$port"
        return 0
      fi
      sleep 0.25
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  free_listen_port "$port"
}

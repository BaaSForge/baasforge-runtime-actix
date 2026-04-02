#!/usr/bin/env bash
# Stop local listeners for units/api (default port from config.ts; override with PORT env when starting).
set -u

PORTS=(1800)

echo "==> Stopping listeners on ports ${PORTS[*]}..."
for port in "${PORTS[@]}"; do
  # macOS lsof: PIDs with IPv4/IPv6 TCP listen on this port
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "    port $port: PIDs ${pids//$'\n'/ }"
    kill -TERM ${pids} 2>/dev/null || true
  fi
done
sleep 2
for port in "${PORTS[@]}"; do
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "    port $port (force): PIDs ${pids//$'\n'/ }"
    kill -KILL ${pids} 2>/dev/null || true
  fi
done

echo "Done."

#!/usr/bin/env bash
# Stop local dev processes: API ports (see dev-scaled.sh / dev.sh), runtime/release worker binaries, cargo watch.
set -u

PORTS=(1501 1502 1503 1504)

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

# Binary name from Cargo.toml: [[bin]] name = "runtime_worker" (path src/bin/runtime_worker.rs)
echo "==> Stopping runtime worker processes..."
pkill -x runtime_worker 2>/dev/null && echo "    pkill -x runtime_worker" || true
pkill -f 'run --bin runtime_worker' 2>/dev/null && echo "    pkill -f 'run --bin runtime_worker'" || true

# Binary name from Cargo.toml: [[bin]] name = "release_listener" (path src/bin/release_listener.rs)
echo "==> Stopping release listener processes..."
pkill -x release_listener 2>/dev/null && echo "    pkill -x release_listener" || true
pkill -f 'run --bin release_listener' 2>/dev/null && echo "    pkill -f 'run --bin release_listener'" || true

echo "==> Stopping cargo watch..."
# dev.sh / dev-runtime-worker.sh use `cargo watch` (installed binary is often `cargo-watch`)
pkill -f "cargo watch" 2>/dev/null && echo "    pkill -f \"cargo watch\"" || true
pkill -x cargo-watch 2>/dev/null && echo "    pkill -x cargo-watch" || true

echo "Done."

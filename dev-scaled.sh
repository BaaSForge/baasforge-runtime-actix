#!/bin/bash
cleanup() {
  kill -TERM -$$ 2>/dev/null
}

trap cleanup SIGINT SIGTERM

./dev.sh 1501 &
./dev.sh 1502 &
./dev-runtime-worker.sh &
./dev-runtime-worker.sh &
./dev-release-listener.sh &
./dev-release-listener.sh &

wait
#!/bin/bash
cleanup() {
  kill -TERM -$$ 2>/dev/null
}
trap cleanup SIGINT SIGTERM

./dev.sh 1501 &
./dev.sh 1502 &
./dev-release-listener.sh &
./dev-release-listener.sh &
./dev-workflow-worker.sh &
./dev-workflow-worker.sh &
./dev-queue-worker.sh &
./dev-queue-worker.sh &
./dev-actor-worker.sh &
./dev-actor-worker.sh &

wait

# Testing

## Prerequisites

- Node.js 22 (`nvm use 22` — required for `ws-tests.mjs` which uses the global `WebSocket`)
- Infrastructure running: `docker compose up -d` (Postgres, Redis, NATS)
- `.env` / `.env.local` with valid `DATABASE_URL`, `WF_REDIS_URL`, `WF_NATS_URL`

## Running the workflow integration tests

```sh
./units/workflow-tests/test.sh
```

## How consumers run during tests

In `TEST_MODE`, the HTTP server **spawns the workflow wake consumer in-process** — no separate `workflow_worker` binary is needed.


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

In `TEST_MODE`, the HTTP server **spawns all three consumers in-process**:

- Workflow wake consumer (`workflow_worker`)
- Queue worker work consumer (`queue_worker_worker`)
- Actor mailbox consumer (`actor_worker`)

No separate worker binaries are needed when running tests.


# Running in Production

## Prerequisites

- PostgreSQL
- Redis (used for both cache and workflow state — can point to the same instance)
- NATS with JetStream enabled

** JetStream data must be persisted on disk (take a look at compose.yml)

## Required env vars

Copy `.env` and fill in real values. Key variables:

```
PORT=1501
DATABASE_URL=postgres://...
REDIS_URL=redis://...
WF_REDIS_URL=redis://...
WF_NATS_URL=nats://...
```

`WF_REDIS_URL` and `WF_NATS_URL` can point to the same Redis/NATS instances as `REDIS_URL` / `NATS_URL` — they are logically separate connection pools.

## Binaries

Run all three processes. Each is an independent binary from the same crate.

### 1. HTTP API server

Serves all HTTP endpoints (API units, workflow triggers, WebSocket).

```sh
cargo run --release
# or after build:
./target/release/baal-runtime-actix
```

### 2. Workflow worker

Consumes the JetStream `WF_WAKE` stream and resumes suspended workflows (sleeps, promises, step retries).

```sh
cargo run --release --bin workflow_worker
# or:
./target/release/workflow_worker
```

Requires `WF_REDIS_URL` and `WF_NATS_URL`. If either is missing the process starts but the consumer is silently disabled.

### 3. Release listener

Listens for deploy events and invalidates the unit cache so newly deployed code is picked up without a restart.

```sh
cargo run --release --bin release_listener
# or:
./target/release/release_listener
```

## Redis (`WF_REDIS_URL`)

- **Persistence must be enabled.** Workflow state (steps, sleeps, promises) lives in Redis. If it is wiped while a workflow is `suspended`, that instance can never resume. Use AOF (`appendonly yes`) or at minimum RDB snapshots (`save 60 1`).
- **Keys are never auto-deleted.** There is no TTL or cleanup job. Redis will grow over time. See [workflow-internals.md](workflow-internals.md#redis-cleanup) for cleanup options.
- **Do not set `maxmemory-policy allkeys-lru`** on the workflow Redis — evicting a suspended workflow's keys breaks resume.

## Stopping

```sh
./dev-stop.sh   # development helper — kills all three processes and frees ports
```


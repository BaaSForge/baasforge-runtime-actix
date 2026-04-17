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

Run all five processes. Each is an independent binary from the same crate.

### 1. HTTP API server

Serves all HTTP endpoints (API units, workflow triggers, actor triggers, queue worker triggers, WebSocket).

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

Requires `WF_REDIS_URL` and `WF_NATS_URL`.

### 3. Queue worker worker

Consumes the JetStream `WQ_WORK` stream and executes queue worker units (including retries, dead-letter, and batch dispatch).

```sh
cargo run --release --bin queue_worker_worker
# or:
./target/release/queue_worker_worker
```

Requires `WQ_REDIS_URL` and `WQ_NATS_URL`.

The `PORT` env var must match the running API server so SDK callbacks resolve correctly (`http://127.0.0.1:{PORT}`).

### 4. Actor worker

Consumes the JetStream `ACTOR_MAIL` stream and dispatches actor mailbox messages.

```sh
cargo run --release --bin actor_worker
# or:
./target/release/actor_worker
```

Requires `ACTOR_REDIS_URL` (or `WQ_REDIS_URL` as fallback) and `ACTOR_NATS_URL` (or `WQ_NATS_URL` as fallback).

The `PORT` env var must match the running API server (same reason as queue worker worker above).

Optional: `ACTOR_NATS_JETSTREAM_STREAM`, `ACTOR_NATS_JETSTREAM_CONSUMER` to override defaults.

### 5. Release listener

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


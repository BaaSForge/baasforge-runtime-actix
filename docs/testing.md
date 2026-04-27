# Testing

## Prerequisites

- Node.js 22 (`nvm use 22` — required for `ws-tests.mjs` which uses the global `WebSocket`)
- Infrastructure running: `docker compose up -d` (Postgres, Redis, NATS)
- `.env` / `.env.local` with valid `DATABASE_URL`, `WF_REDIS_URL`, `WF_NATS_URL`

## Running the workflow integration tests

```sh
./units/workflow-tests/test.sh
```

Similar entrypoints:

- `./units/actor-tests/test.sh` — actor SDK + API runner
- `./units/queue-worker-tests/test.sh` — queue worker SDK + API runner

## `units/*` integration layout (isolation)

The three trees **`units/actor-tests`**, **`units/workflow-tests`**, and **`units/queue-worker-tests`** are **self-contained**: their `test.sh` scripts do not compile or seed from a sibling `units/` folder. Homonymous-path and cross-type checks still use the same runtime unit paths (`test.actor-tests.*`, `test.wf.*`, `test.queue-worker.*`) where the product expects them.

If you add a test that needs another unit type, **copy the minimal unit source into that suite’s tree** (or add a small new file there) and wire it through the same env dirs—do not point `test.sh` at `../other-suite/dist`.

## How consumers run during tests

In `TEST_MODE`, the HTTP server **spawns all three consumers in-process**:

- Workflow wake consumer (`workflow_worker`)
- Queue worker work consumer (`queue_worker_worker`)
- Actor mailbox consumer (`actor_worker`)

No separate worker binaries are needed when running tests.

## Stage A / stage B variants of the same unit (test seed)

`TEST_MODE` seeds **production** plus **two** stage test runtimes (stage A and stage B). Some integration tests need the *same* unit path (`test.*.*.<name>.1`) to run different compiled code on stage A vs stage B (runtime isolation, WebSocket routing, etc.).

That is already wired in the **test seeder**, not something to reinvent:

- Workflow, queue-worker, and actor test units are discovered from their trees as today.
- If the **filename stem** (the part before `.ts` / `.js`) ends with one of these suffixes, the seeder attaches that file only to the matching stage release and merges it over the default unit for that path:
  - **Stage A only:** `-runtime-stage-a`
  - **Stage B only:** `-runtime-stage-b`
- The suffix is stripped when building the unit slug, so e.g. `my-case-runtime-stage-b.ts` is the stage-B override for the same logical unit as `my-case.ts`.

Authoritative logic: `stem_without_runtime_suffix` in [`src/services/test_seed/mod.rs`](../src/services/test_seed/mod.rs).

**Do not** add a second mechanism (extra env vars, duplicate seed paths, or ad-hoc DB inserts) for “this file only on stage B”—extend the existing suffix convention and seeder if a new case is missing.


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

## Unit runtime tests (prefer `units/` over Rust integration tests)

Behavioral coverage for **workflow**, **queue-worker**, and **actor** runtimes (HTTP triggers, real consumers in `TEST_MODE`, Redis/NATS/Postgres where applicable) should live in **`units/workflow-tests`**, **`units/queue-worker-tests`**, and **`units/actor-tests`** (TypeScript, end-to-end).

Do **not** add Rust integration tests for the same product-level behaviors unless there is a concrete reason (for example pure logic with no I/O). This keeps one obvious place for suite runners and matches how CI invokes `./units/*/test.sh`.

Actor durable state in **Actor Postgres** (`actor_snapshots`) is described in [`docs/actors-internals.md`](actors-internals.md); schema is under [`migrations/actors/`](../migrations/actors/). In `TEST_MODE`, actor trigger routes expose introspection used only by the actor test runner (`GET .../snapshot-pg` and the same path under `.../stage/{runtimeId}/...`, plus matching `POST .../test-evict-redis`).

## `units/*` integration layout (isolation)

The three trees **`units/actor-tests`**, **`units/workflow-tests`**, and **`units/queue-worker-tests`** are **self-contained**: their `test.sh` scripts do not compile or seed from a sibling `units/` folder. Homonymous-path and cross-type checks still use the same runtime unit paths (`test.actor-tests.*`, `test.wf.*`, `test.queue-worker.*`) where the product expects them.

If you add a test that needs another unit type, **copy the minimal unit source into that suite’s tree** (or add a small new file there) and wire it through the same env dirs—do not point `test.sh` at `../other-suite/dist`. Example: actor-tests keeps homonymous-path workflow/qw sources under `seed-workflows/` and `seed-queue-workers/` (compiled next to actors into `dist/seed-workflows`, `dist/seed-queue-workers`); the test seeder skips those prefixes when walking `TEST_ACTOR_DIR` so they are only picked up via `TEST_WORKFLOW_DIR` / `TEST_QUEUE_WORKER_DIR`.

## Parallel runs (write tests accordingly)

**Workflow / actor / queue-worker API runners** start **all** declarative and endpoint-style cases in one `Promise.all` (see `handleRequest` in each suite’s `index.ts`). **`workflow-tests/test.sh`** also runs the trigger HTTP suite and **`ws-tests.mjs`** at the same time. Assume **many** concurrent instances on the same project and NATS subjects.

**Pitfalls**

1. **Per–unit-path dedup (workflows)** — For a given project and production path, the engine keeps **at most one** running or suspended instance per `test.wf.<slug>` (see [`workflow_engine.rs`](../src/services/workflow_engine.rs): `workflow_dedup_name_key`, `start_workflow`). Two tests that `POST` the **same** workflow slug while both are active can attach to the **same** `instanceId`, share handlers/cancel, and flake (wrong `result`, `cancel` → 400 `workflow already …`). **Fix:** give each test its **own** workflow unit (duplicate source with a new filename/slug) or only one test may own that slug while non-terminal.

2. **WebSocket assertions** — A socket subscribed to `wf.events.{project}.>` will see **everyone’s** lifecycle frames. **Do not** assert `workflow.*` count is zero while another test runs workflows. **Fix:** record the `instanceId` (or run id) you started in that test and assert that id **does not** appear on the wrong URL (prod vs stage) or assert only frames for **your** id on the expected side.

**Actor / queue-worker suites** — Same idea: shared dedup or global streams where applicable; scope assertions to **your** instance or run id.

## How consumers run during tests

In `TEST_MODE`, the HTTP server **spawns all consumers in-process**:

- Workflow wake consumer (`workflow_worker`)
- Queue worker work consumer (`queue_worker_worker`)
- Actor mailbox consumer (`actor_worker`)
- Usage ingest listener (`usage_ingest_worker`) when `USAGE_INGEST_ENABLED=true`

No separate worker binaries are needed when running tests. Usage from test runs is persisted to `project_usage_entries` via the inline ingest listener (no dedicated test assertions).

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


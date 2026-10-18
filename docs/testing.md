# Testing

## Test layers

The repository has two test layers:

- Rust tests for host-side helpers and route logic.
- TypeScript integration suites under `units/` for product behavior in QuickJS.

The integration suites are the main health checks for unit execution.

## Requirements

- Node.js 22
- Rust and Cargo
- the release build dependencies
- main and Actor PostgreSQL databases
- Redis
- NATS with JetStream
- valid `.env` or `.env.local` connections
- applied Actor migrations for Actor tests

`docker compose up -d` starts NATS, but it does not start PostgreSQL. Its Redis service is commented out. Start both databases and Redis separately.

Do not run suites that share a default port at the same time. Set `TEST_PORT` when you need an isolated port.

## Rust tests

```sh
./test.sh
```

This runs:

```sh
cargo test --all-targets
```

These tests cover selected Rust helpers such as authentication middleware, routing, bytecode, module shims, runtime environment handling, release loading, and usage metering. They do not replace the product integration suites.

## Integration suites

| Command | Main signal |
| --- | --- |
| `./units/runtime-check/test.sh` | QuickJS language, web, Node-compatible module, and module-loader support. |
| `./units/api-tests/test.sh` | API-unit routing, methods, stages, timeouts, and SDK calls. |
| `./units/common/test.sh` | Common-unit imports, export forms, policy, and SDK use through common modules. |
| `./units/workflow-tests/test.sh` | Durable workflow execution, replay, steps, sleep, promises, retries, compensation, stages, and cross-unit calls. |
| `./units/queue-worker-tests/test.sh` | Queue delivery, retries, dead letters, delay, deduplication, rate limits, batches, stages, and SDK calls. |
| `./units/actor-tests/test.sh` | Sequential mailboxes, state, snapshots, retries, passivation, alarms, stages, limits, and SDK calls. |

`units/runtime-check/packages/test.sh` runs the supported package suites in QuickJS and returns a failing exit status when a package report is unhealthy. `units/runtime-check/packages/test-node.sh` runs package checks in Node for compatibility comparison; it does not test QuickJS.

## How integration tests run

Each suite:

1. Installs or builds its TypeScript runner and fixture units.
2. Builds or reuses `target/release/baal-runtime-actix`.
3. starts the API with `TEST_MODE=1`.
4. Seeds a fixed test project, production release, and stage A and B releases.
5. Executes a trigger that returns a JSON health report.
6. Runs WebSocket checks where applicable.
7. writes `.output.log` in the suite directory.

In `TEST_MODE`, the API process starts these consumers in-process:

- workflow wake consumer
- queue-worker work consumer
- Actor mailbox consumer and alarm sweeper
- usage ingest consumer when enabled

Separate worker binaries are not required for these tests.

## Reading results

A healthy integration report means that the tested runtime path worked with the configured PostgreSQL, Redis, NATS, HTTP, WebSocket, and QuickJS components.

Inspect:

- `summary.healthy`
- `summary.total_failed`
- the suite `.output.log`
- the WebSocket report, when present

> Several main suite scripts can exit with status `0` even when the JSON report contains failed cases. A successful shell exit alone does not mean that the suite passed.

## What each suite tells you

### Runtime check

A healthy report confirms the listed language features, runtime globals, module shims, fetch behavior, and supported npm package adapters. It does not prove support for packages that are not in the suite.

Keep `units/runtime-check` dependencies aligned with the backend type-check environment. See its README for the sync contract.

### API and common units

Healthy reports confirm route resolution, production and stage isolation, QuickJS API execution, supported common-unit imports, and tested SDK calls.

### Workflows

A healthy report confirms the tested workflow state, wake, replay, retry, timer, compensation, and SDK paths. It uses real Redis and JetStream, but the consumer runs inside the API test process.

### Queue workers

A healthy report confirms the tested delivery, retry, dead-letter, batch, rate-limit, stage, and cross-unit paths. It does not verify the separately deployed queue-worker image.

### Actors

A healthy report confirms tested mailbox ordering, hot state, PostgreSQL snapshots, passivation, alarms, retry, stage isolation, and SDK behavior. Alarm cases can be sensitive to machine load.

## Limits

The current suites do not prove:

- that all six production containers start and communicate
- that `runtime_cache_listener` receives backend release and environment events
- multi-host or multi-region behavior
- production reverse-proxy and TLS behavior
- production load capacity
- every crash or process-restart recovery path
- skipped Actor event and secrets behavior

Some restart tests do not kill a real process. Some Actor cases are skipped. Read skipped results and suite notes before making durability claims.

Usage ingest can run in `TEST_MODE`, but there is no dedicated end-to-end usage-ingest suite.

## CI behavior

The deploy workflow contains a matrix for the integration suites, but `RUN_TESTS` defaults to `false`. The repository has no pull-request workflow that runs Rust tests, formatting, Clippy, or TypeScript checks.

Run required checks locally before tagging a release.

## Adding tests

- Add product behavior to the matching `units/` suite.
- Keep fixture units inside that suite.
- Use unique unit paths for concurrent workflow cases.
- Scope event assertions by the instance, run, actor, project, or stage under test.
- Use the existing `-runtime-stage-a` and `-runtime-stage-b` filename suffixes for stage-specific fixture variants.
- Add pure Rust tests for isolated host logic when an integration unit is not suitable.

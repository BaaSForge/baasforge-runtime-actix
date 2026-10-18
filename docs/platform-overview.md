# BaaSForge platform overview

BaaSForge separates control-plane work from unit execution:

- [baasforge-backend-actix](https://github.com/BaaSForge/baasforge-backend-actix) manages projects, source code, type checks, releases, and runtime environment variables.
- This repository loads deployed releases and executes units in QuickJS.

See [Runtime architecture](architecture.md) for process and infrastructure details.

## Units

A unit is a TypeScript or JavaScript function in a project. Its path has four segments:

```text
context.module.unit_type.name
```

Implemented unit types:

| Type | Model |
| --- | --- |
| API | Stateless HTTP request and response. |
| Workflow | Durable, replayed, multi-step execution. |
| Queue worker | Asynchronous job execution with retry and dead-letter behavior. |
| Actor | Entity-scoped state with sequential message processing. |

## Execution

1. The backend compiles and publishes a release.
2. It writes release metadata to PostgreSQL and publishes a NATS release event.
3. The runtime cache listener invalidates stale release data.
4. A trigger reaches the runtime API.
5. The runtime resolves and caches the deployed unit.
6. QuickJS evaluates its compiled JavaScript with supported modules and SDK host functions.
7. The API returns a response or publishes durable work for a worker.

## SDK and unit imports

The `@sdk` module exposes runtime capabilities. Each callable unit type uses an explicit operation, such as workflow, queue-worker, or Actor calls.

Type-only unit imports use:

```typescript
import type { Input, Output } from "@units/context.module.workflow.name";
```

The backend validates and removes compile-time imports before deployment. Runtime calls use SDK operations, not JavaScript imports between unit files.

Common units provide shared runtime code through the supported `@units` module-loader path. `units/common` tests the allowed forms and policies.

## Isolation

Runtime state is scoped by project and, where applicable, stage runtime:

- database lookups include project and release identity
- Redis keys include project and execution identity
- NATS subjects include project and instance identity
- Actor snapshots include project, unit, actor, and stage identity
- SDK calls stay within the current project

The Rust host layer enforces this application-level isolation. Projects can share the same PostgreSQL, Redis, and NATS services.

## Data ownership

| Data | Owner | Storage |
| --- | --- | --- |
| Projects, units, releases, runtime environment | Backend control plane | Main PostgreSQL |
| Release and environment caches | Runtime | Redis |
| Workflow state | Runtime | Redis |
| Queue-worker state | Runtime | Redis |
| Hot Actor state and leases | Runtime | Redis |
| Durable Actor snapshots and alarms | Runtime | Actor PostgreSQL |
| Durable work and invalidation events | Shared interface | NATS JetStream |
| Live execution events | Runtime | Core NATS |

The main PostgreSQL schema is migrated by the backend repository. Actor PostgreSQL is migrated by this repository.

## Runtime support as executable evidence

The `units/` tree contains integration fixtures and health suites:

- `runtime-check`: QuickJS language, module, web API, and supported package behavior
- `api-tests`: API-unit behavior
- `common`: common-unit imports and policies
- `workflow-tests`: durable workflow behavior
- `queue-worker-tests`: queue-worker behavior
- `actor-tests`: Actor behavior

These suites define tested behavior, not unlimited compatibility. A package or runtime feature is supported only when the implementation and its tests cover it.

See [Testing](testing.md) for known test and CI limits.

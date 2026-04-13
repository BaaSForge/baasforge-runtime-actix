# BAAL Platform Overview

## What Is BAAL?

BAAL is a supabase-like "Architecture-as-a-Service" platform. Where Supabase and Firebase answer "How do I get a backend running fast?", BAAL answers "How do I build a *serious* distributed backend without an infrastructure team?"

Users create **projects**. Each project contains **units** — NodeJS functions that run inside this runtime (an Actix-web server embedding QuickJS via `rquickjs`). Projects can contain thousands of units.

## Units

A **unit** is the core primitive of the platform. Every unit is a JavaScript/TypeScript function that belongs to a project and is identified by a four-segment path:

```
{context_slug}.{module_slug}.{unit_type}.{unit_name_slug}
```

For example: `billing.payments.workflow.charge`

### Supported Unit Types


| Type       | Entry Point                              | Description                                                                   |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `api`      | `handleRequest(req, res)`                | HTTP request-response function. Triggered via public URL.                     |
| `workflow` | `export default workflow(name, handler)` | Durable multi-step workflow that survives crashes, restarts, and deployments. |


More unit types (actors, sagas, event sourcing, stream processing, state machines, scheduled, queue workers, websockets) are planned — see `docs/killers-features.md`.

### How Units Execute

1. A request arrives at the Actix-web runtime (via public trigger URL).
2. The runtime loads the unit's `compiled_code` from PostgreSQL (cached in Redis).
3. A QuickJS context is created inside `tokio::task::spawn_blocking`.
4. Core modules are registered (URL, fetch, crypto, Buffer, encoding, etc.).
5. The `@sdk` module globals are injected (for workflow units: `workflow`, `sdk`, and the workflow context).
6. `import` / `export` statements are stripped from the user code in another repo (the user's dashboard repo).
7. The user code is evaluated and the appropriate entry point is called.
8. The result is returned to the caller.

### Triggering Units

Each unit type has its own trigger URL prefix:

- **API units**: `/api/v1/trigger/{project_id}/{context}/{module}/{unit_name}`
- **Workflow units**: `/api/v1/trigger/wf/{project_id}/{context}/{module}/{workflow_name}`

Units can also be triggered internally via `sdk.call(unitPath, data)` from within any unit's code.

## The `@sdk` Module

All platform capabilities are exposed to units through the `@sdk` module. Users write:

```typescript
import { workflow, sdk } from "@sdk";
```

At runtime, `import` statements are stripped and `workflow`, `sdk`, etc. are available as pre-initialized globals. No user setup or configuration is needed — every tool is initialized and managed by the platform, scoped to the unit's project.

### `sdk.call()` — Inter-Unit Communication

`sdk.call(unitPath, data)` is the universal primitive for inter-unit communication. Currently it supports triggering **workflow units only**. It can be called from any unit type. Support for other unit types will be added as they are implemented.

```typescript
const result = await sdk.call("billing.payments.workflow.charge", { orderId, amount });
```

## Cross-Unit Type Exports and Imports

Units can export TypeScript types that other units import for compile-time type safety when calling them via `sdk.call()`. This is **compile-time only** — type imports are stripped at runtime just like `node:`* imports.

### Import Syntax

```typescript
import type { Input, Output } from "@units/billing.payments.workflow.charge";
```

The path uses dot notation matching the unit ID format: `@units/{context}.{module}.{unitType}.{name}`.

### Export Convention (Workflow Units)

Workflow units may export the following named types (plus the required `export default workflow(...)`):


| Export Name           | Required    | Description                                                   |
| --------------------- | ----------- | ------------------------------------------------------------- |
| `Input`               | Yes         | The input type passed to the workflow's `run` handler         |
| `Output`              | Yes         | The return type of the workflow's `run` handler               |
| `{HandlerName}Input`  | Per handler | Input type for a shared handler (PascalCase name + `Input`)   |
| `{HandlerName}Output` | Per handler | Return type for a shared handler (PascalCase name + `Output`) |


Only `export type` and `export interface` are allowed — no value exports besides `export default`.

### Lint Rules

Lint/type-checking of unit code is performed by the **dashboard platform** (a completely separate project). That project validates unit code before deployment. The rules it enforces:

1. **Exports**: Only `export type` and `export interface` are allowed (plus `export default`).
2. **Export names**: Must match `Input`, `Output`, or `{PascalCase}Input` / `{PascalCase}Output` for workflow units, and we will have others for other unit types later
3. **Imports from `@units/*`**: Only `import type` is allowed (no value imports).
4. **Import path**: Must be a valid dot-notation unit path.

This runtime project does not implement or test these lint rules — it only needs to be aware of the convention so the SDK types are compatible.

> **Convention note for future unit types:** Every unit type that supports `sdk.call()` must define its own export convention following this same pattern. This ensures a consistent, lintable pattern across all unit types.

## The `units/` Folder — Source of Truth

The `units/` folder in this repository is the **source of truth** for what code is allowed inside units:

- `**units/runtime-check/`** — Tests all core language and Node.js API features available in the QuickJS runtime (ES language features, `node:crypto`, `node:buffer`, `node:url`, `node:querystring`, `node:util`, `node:timers/promises`, `fetch`, `URL`, `TextEncoder`/`TextDecoder`, etc.). The runtime supports the **exact same features** listed here.
- `**units/workflow-tests/`** — Tests all Durable Workflow SDK features (`ctx.run`, `ctx.sleep`, `ctx.promise`, `ctx.set`/`get`, `ctx.rand`, `ctx.date`, `TerminalError`, compensation, parallel execution, `sdk.call` for workflow triggering, shared handlers, crash recovery, and cross-project isolation).

### Allowed Imports

Only the following import sources are permitted in unit code:

1. `**node:***` — As listed in `units/runtime-check/index.ts` (e.g. `node:crypto`, `node:buffer`, `node:url`, `node:querystring`, `node:util`, `node:timers/promises`).
2. `**@sdk**` — The platform SDK module (`workflow`, `sdk`, and other exports).
3. `**@units/***` — Type-only imports from other units (`import type { ... } from "@units/..."`).

Nothing else is allowed. All imports are stripped at runtime.

## Project Isolation

Projects are **completely isolated**. Every SDK tool is scoped by `project_id`, preventing cross-project access:

- **Redis keys**: Prefixed with `wf:{project_id}:` — a unit in Project A cannot read or write keys belonging to Project B.
- **NATS subjects**: Scoped as `wf.{project_id}.{instance_id}.wake` — subscriptions are filtered by project.
- **Workflow state**: All step results, promises, state, and metadata are keyed by project ID.
- `**sdk.call`**: Can only invoke units within the same project.

This isolation is enforced at the Rust host function layer, not at the infrastructure level. A single shared Redis instance and NATS cluster serve all projects.

## Infrastructure

The runtime requires the following infrastructure (defined in `compose.yml`):


| Service                     | Purpose                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Redis** (AOF persistence) | Workflow step state, durable promises, workflow metadata, `ctx.set/get` state. Data lives in RAM for sub-millisecond reads, appended to disk for durability. |
| **NATS JetStream**          | Workflow wake-up signals (timer expiry, promise resolution), inter-service messaging.                                                                        |
| **nginx**                   | Load balancer for the runtime instances.                                                                                                                     |


The runtime's PostgreSQL database (defined in the dashboard platform's infrastructure) stores unit code, project metadata, and release information. It is completely separate from the workflow state storage.

## Database Separation

The runtime project's database schema (`src/schema.rs`) is for the **dashboard platform** — it stores projects, units, releases, chat sessions, etc. Workflow execution state (step results, promises, timers) is stored in **Redis**, which is a separate service managed by this runtime. The two never mix.
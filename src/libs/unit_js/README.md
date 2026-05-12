# unit_js — rules for injected JS

> **Read this before editing any file under `src/libs/unit_js/scripts/` or adding a new `sdk.*` method.**
> Violating these rules silently breaks the runtime security model and creates duplicated code across unit types.

## Context

Every unit type (api, actor, queue_worker, workflow) runs user TypeScript/JavaScript inside a QuickJS runtime via `rquickjs`. Before `eval`, we inject:

1. `scripts/runtime-shared.js` — shared globals (`sdk`, `__stripImports`, module registry).
2. One per-unit-type script — `api-runtime.js` / `actor-runtime.js` / `queue-worker-runtime.js` / `workflow-runtime.js` — wires up the unit's entry point and result serialization.

These scripts are **not** where business logic lives. They are the glue between user code and the Rust runtime.

**Context accessors:** If user-facing glue exposes a value with a JS `get foo()` that reads an internal backing field the host later serializes (actor state, response status, etc.), a **`set foo()` must update that same backing store** (or use an explicit method instead of a writable-looking property). A getter with no setter makes assignments like `ctx.foo = { ... }` look valid—TypeScript will not flag them—while the write either does nothing useful (sloppy mode) or throws (strict mode) and persistence still follows the old backing object, which is easy to mistake for “handler returned empty state.”

## Hard rules

### 1. No `fetch()` to internal routes from injected JS

The public trigger routes — `POST /api/v1/trigger/actor/...`, `POST /api/v1/trigger/workerQueue/...`, `POST /api/v1/trigger/wf/...`, etc. — exist for **external callers** of the platform. Compiled user units run **in-process** with the runtime; they must use internal Rust host functions instead.

| Wrong | Right |
| --- | --- |
| `sdk.callActorAndWaitForResultSync` doing `await fetch(baseUrl + "/api/v1/trigger/actor/...")` | `sdk.callActorAndWaitForResultSync` calling host fn `__baal_call_actor_sync(...)` |
| `sdk.enqueueWorkerSync` doing `fetch(...)` to `workerQueue` | `sdk.enqueueWorkerSync` calling `__baal_enqueue_worker(...)` |
| `sdk.callWorkflowAndWaitForOutputSync` polling `/api/v1/trigger/wf/.../result` | `sdk.callWorkflowAndWaitForOutputSync` calling `__baal_call_workflow_sync(...)` (outside a workflow) or `__baal_start_call(...)` + durable promise (inside a workflow `run`) |

Internal host functions live in [modules/sdk.rs](modules/sdk.rs) and read handles (Redis, NATS, JetStream, `DbPool`, `ActorLocks`) from a thread-local `SdkCommCtx` that is never exposed to JS.

Note on `fetch` itself: the global `fetch()` (from [scripts/fetch.js](scripts/fetch.js)) **is** still valid inside user code for calling external HTTP. The rule above only forbids injected-SDK helpers from using `fetch` to reach platform-internal routes.

### 2. Injected JS must be a thin proxy, nothing else

Any `sdk.*` helper or runtime glue function may only:

- Validate / normalize inputs (e.g. check `unitPath` has 4 dotted segments).
- `JSON.stringify` args, call a `__baal_*` host function, `JSON.parse` the result.
- Translate a host error string into a JS `Error` / `TerminalError`.

Forbidden inside injected JS:

- Network calls (no `fetch` to internal routes, no WebSocket, no NATS clients).
- Persistence logic (no key building, no Redis/SQL semantics).
- Retry / backoff / timeout loops that duplicate host-side logic — host functions own those.
- Background tasks (no `setInterval`, no long-lived promise chains).

If you need new functionality, add a `__baal_*` host function in `modules/sdk.rs` and proxy to it. Do **not** re-implement the work in JS.

### 3. Shared SDK helpers live in exactly one file

- `sdk.callActorAndWaitForResultSync`, `sdk.sendActorMessageSync`, `sdk.enqueueWorkerSync`, `sdk.startWorkflowSync`, `sdk.callWorkflowAndWaitForOutputSync`, `sdk.callWorkflowHandlerAndWaitForResultSync`, and any future `sdk.*` method belong in [scripts/runtime-shared.js](scripts/runtime-shared.js).
- Per-unit-type scripts may **override** a helper when a different semantic is required (e.g. `workflow-runtime.js` replaces `sdk.callWorkflowAndWaitForOutputSync` to suspend on a durable promise instead of blocking). Overrides must still be thin proxies to host functions.
- Do **not** copy a helper into more than one script.

### 4. No duplication of per-unit-type globals like `__baal_*_base_url`

Early versions shipped `__baal_actor_base_url`, `__baal_actor_project_id`, `__baal_qw_base_url`, etc. These existed only to build HTTP URLs in JS. They are obsolete: the host functions read `project_id` and everything else from `SdkCommCtx`. Do not add new ones.

## Where to put new work

| You want to… | Do this |
| --- | --- |
| Add a new `sdk.fooBar(...)` method | 1. Add `__baal_foo_bar` in [modules/sdk.rs](modules/sdk.rs). 2. Add a 5-line proxy in [scripts/runtime-shared.js](scripts/runtime-shared.js). 3. Update [units/shared/@sdk.d.ts](../../../units/shared/@sdk.d.ts). |
| Change how actor calls work under the hood | Edit the host function in `modules/sdk.rs` and/or `services/actor_engine.rs`. Do **not** touch the JS proxy unless its signature changes. |
| Give workflows a different behaviour for an existing `sdk.*` method | Override it inside [scripts/workflow-runtime.js](scripts/workflow-runtime.js) — still as a thin proxy (e.g. to `__baal_start_call`). |
| Add a Node-like module polyfill (e.g. `node:crypto`) | Add a module under `modules/` and register it in `modules/mod.rs`. Keep JS wrappers in `scripts/` minimal. |

## Review checklist

Before merging any change under `src/libs/unit_js/scripts/`:

- [ ] No `fetch("http...")` targeting `/api/v1/...` or `localhost:PORT`.
- [ ] No Redis/NATS/SQL concepts leaking into JS.
- [ ] The same helper is not defined in two scripts.
- [ ] Any new helper has a matching host function and a `@sdk.d.ts` type.
- [ ] JS added is ≤ ~30 lines; if longer, the work probably belongs in Rust.
- [ ] No new getter-only context/`res` fields for host-serialized state (pair `get` with `set` or use a method; see **Context accessors** above).

# API and development conventions

## JSON keys

All new or changed public JSON contracts must use `snake_case` keys.

This applies to:

- REST request and response bodies
- WebSocket event payloads
- manually built JSON
- OpenAPI schemas
- documented client contracts

Use:

```text
stopped_count
stopped_message_ids
project_id
chat_session_id
message_id
chunk_index
runtime_id
```

Do not introduce:

```text
stoppedCount
stoppedMessageIds
projectId
chatSessionId
messageId
chunkIndex
runtimeId
```

Keep Rust field names in `snake_case`. Avoid `#[serde(rename = "camelCase")]` for public payloads. Use `#[serde(rename_all = "snake_case")]` when enum variants must serialize as snake case.

Some existing internal or legacy payloads still use camelCase. Treat them as compatibility contracts. Do not copy that style into new public fields, and do not rename an existing field without a coordinated backend and client migration.

## Database IDs

New entity tables that have an `id` primary key must use UUID version 7:

- Do not add integer or auto-incrementing entity IDs.
- Generate UUID v7 values for all new entity rows.
- Keep migration, Diesel schema, API, and client types consistent.

Runtime state tables can use documented composite natural keys when identity is defined by fields such as project, unit, Actor, or stage. Do not add a synthetic integer ID to those tables.

The main database is owned by the backend repository. Apply this convention in its migrations. Actor database migrations belong in this repository.

## ID generation in Rust

Create new entity IDs only with:

```rust
crate::libs::ids::new_uuid()
```

Do not generate IDs directly with methods such as:

```rust
Uuid::new_v4()
Uuid::now_v7()
Uuid::new_v7()
```

`clippy.toml` disallows direct UUID constructors. The shared helper uses `uuidv7`.

## Clippy enforcement

`.cargo/config.toml` sets `clippy-driver` as the Rust compiler wrapper. Normal `cargo build` and `cargo run` commands therefore compile and apply Clippy rules.

Install Clippy:

```sh
rustup component add clippy
```

Run the full lint explicitly:

```sh
CARGO_BUILD_RUSTC_WRAPPER= cargo clippy --all-targets
```

If the wrapper breaks a build script or version probe, bypass it for that command:

```sh
CARGO_BUILD_RUSTC_WRAPPER= cargo build
```

The current GitHub Actions workflow does not run Clippy on pushes or pull requests. Run it locally before review and release.

## QuickJS SDK bridge

Compiled user units run in-process inside QuickJS. Injected JavaScript under `src/libs/unit_js/scripts/` must be a thin proxy over `__baal_*` Rust host functions.

Injected SDK code must not call internal routes with `fetch()`, including:

- `/api/v1/trigger/actor/...`
- `/api/v1/trigger/workerQueue/...`
- `/api/v1/trigger/wf/...`

Those routes are for external callers. User code can still use global `fetch()` for external HTTP requests.

Shared `sdk.*` helpers belong in `src/libs/unit_js/scripts/runtime-shared.js`. Define them once. A per-unit-type script can override a helper only when that unit type needs different semantics, and the override must remain a thin host-function proxy.

Put Redis, NATS, JetStream, SQL, retry, timeout, and locking logic in Rust. When adding an SDK method:

1. Add the `__baal_*` host function in `src/libs/unit_js/modules/sdk.rs`.
2. Add the thin shared JavaScript proxy.
3. Update `units/shared/@sdk.d.ts`.
4. Add integration coverage.

See [`src/libs/unit_js/README.md`](../src/libs/unit_js/README.md) for the full rules, placement table, and review checklist.

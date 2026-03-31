# baal-runtime-actix

## Runtime caching and NATS release events

**Domain rule:** each project is expected to have **at most one production runtime**. Runtime-scoped Redis caches are split by *scope* only (not by iterating every runtime):

- **Production:** keys under `{project_id}:prod:` (single namespace per project for live prod release + units).
- **Stage:** keys under `{project_id}:stage:{runtime_id}:` per stage runtime.

When the `release_listener` process receives a JetStream **release deploy** message, it calls `clear_project_runtime_cache_on_deploy` with **exactly one** scope: either `Prod` or `Stage { runtime_id }` from the event. That routine deletes only (1) the cached release JSON for that scope and (2) per-unit keys that appeared in the previously live release but not in the newly deployed release’s `combinedUnitIDs`. It does **not** flush Redis, pattern-scan keys, or invalidate other stage runtimes or production when only one environment/runtime changed.

Stage payloads **must** include `runtime_id`. Production uses the shared prod scope above (there is only one prod runtime per project in this model).

See module documentation in `src/services/release_listener.rs` and `src/services/project_runtime_cache.rs` for publisher/consumer details.

## To fix libpg issue (library not found)

[GPT Conversation](https://chatgpt.com/share/698ccc50-aea8-800e-b2d2-fb27cb695f0d)

```sh
brew install postgresql
brew install libpq
brew link --force libpq
```

```sh
cargo clean
cargo build
```

Add this to ~/.cargo/config.toml:
```toml
[env]
LIBRARY_PATH = "/opt/homebrew/opt/libpq/lib"
```
(Use `brew --prefix libpq` to get correct path)

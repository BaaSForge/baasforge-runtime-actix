# baal-runtime-actix

## Runtime caching and NATS release events

**Domain rule:** each project is expected to have **at most one production runtime**. Runtime-scoped Redis caches are split by *scope* only (not by iterating every runtime):

- **Production:** keys under `{project_id}:prod:` (single namespace per project for live prod release + units).
- **Stage:** keys under `{runtime_id}:` per stage runtime.

When the `runtime_cache_listener` process receives a JetStream **release deploy** message, it calls `clear_project_runtime_cache_on_deploy` with **exactly one** scope: either `Prod` or `Stage { runtime_id }` from the event. Production and stage use the same logic (only the Redis key prefix differs): delete the cached release row and **all** per-unit keys for that scope. Caches refill on the next read-through load. Other stage runtimes and production are not touched when only one scope changes.

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

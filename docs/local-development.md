# Local development

## Requirements

- Rust and Cargo
- Node.js 22 and npm
- Docker with Compose
- PostgreSQL for backend data
- PostgreSQL for Actor state
- Redis
- Diesel CLI 2.3.x
- `lsof` and `pkill` for `dev-stop.sh`

The local [BaaSForge backend](https://github.com/BaaSForge/baasforge-backend-actix) normally provides the main PostgreSQL database. This repository does not configure that application.

## Environment files

The runtime loads `.env`, then loads `.env.local` with override behavior. Keep machine-specific values in `.env.local`; Git ignores that file.

`.env.stage` and `.env.prod` are Docker build inputs. They are copied into staging and production images. They are not local override files.

> **Security: Credentials and connection values in tracked environment and Compose files are local-development defaults. Override all of them outside local development.**

At minimum, connect:

- `DATABASE_URL` to the backend-owned PostgreSQL database.
- `ACTOR_DATABASE_URL` to the runtime-owned Actor PostgreSQL database.
- cache, workflow, queue-worker, and Actor Redis URLs.
- general, workflow, queue-worker, and Actor NATS URLs.
- `RUNTIME_PRIVATE_API_KEY` to the same value used by the backend.

Keep the release and runtime-environment NATS stream and subject settings equal in both repositories.

## Start infrastructure

```sh
docker compose up -d
```

`compose.yml` starts:

- NATS with JetStream and persistent data under `.dev/nats-jetstream`.
- nginx on port `1500`.

It does not start PostgreSQL. Its Redis service is commented out. Start both databases and Redis separately before the runtime.

Optional local tracing:

```sh
docker compose -f compose.telemetry.yml up -d
```

Jaeger receives OTLP on ports `4317` and `4318`. Its UI is at `http://localhost:16686`.

## Actor database

Apply Actor migrations before the Actor worker starts:

```sh
./actors-migration-up.sh
```

See [Database migrations](db-migrations.md) to create, revert, and inspect migrations.

## Start the runtime

Start one API process:

```sh
./dev.sh 1501
```

Start workers in separate terminals:

```sh
./dev-workflow-worker.sh
./dev-queue-worker.sh
./dev-actor-worker.sh
./dev-runtime-cache-listener.sh
./dev-usage-ingest-worker.sh
```

Or start the scaled development topology:

```sh
./dev-scaled.sh
```

The scaled script starts:

- API servers on `1501` and `1502`
- two workflow workers
- two queue workers
- two Actor workers
- two cache listeners
- one usage-ingest worker

Stop local Rust processes with:

```sh
./dev-stop.sh
```

Stop Compose services with:

```sh
docker compose down
docker compose -f compose.telemetry.yml down
```

## nginx

The development nginx configuration listens on port `1500` and uses `least_conn` across API ports `1501` and `1502`. It also forwards WebSocket upgrade headers.

Use `http://localhost:1500` for the backend runtime URL when `dev-scaled.sh` is running. If you run only `./dev.sh 1501`, you can use `http://localhost:1501`.

`nginx.dev.conf` is for local development. It is not a production TLS configuration.

## Source changes and reloads

The API and workflow-worker scripts run `cargo clippy` before `cargo run`. The other worker scripts run `cargo run`. `.cargo/config.toml` also runs normal Cargo builds through `clippy-driver`. All scripts have commented-out `cargo watch` commands.

There is no automatic hot reload for any process. Stop and rerun the affected script after a Rust source change:

- API or shared route code: restart `dev.sh`.
- Workflow engine code: restart `dev-workflow-worker.sh`.
- Queue-worker code: restart `dev-queue-worker.sh`.
- Actor code: restart `dev-actor-worker.sh`.
- Cache invalidation code: restart `dev-runtime-cache-listener.sh`.
- Usage ingest code: restart `dev-usage-ingest-worker.sh`.

Shared crate changes can affect all processes. Restart the complete topology when uncertain.

## Code quality

Rust formatting:

```sh
cargo fmt --all
cargo fmt --all -- --check
```

Rust lint:

```sh
CARGO_BUILD_RUSTC_WRAPPER= cargo clippy --all-targets
./clippy-fix.sh
```

Rust tests:

```sh
./test.sh
```

The `units/` integration runners install and compile their TypeScript dependencies before execution. Run the suite that matches the changed runtime area:

```sh
./units/runtime-check/test.sh
./units/api-tests/test.sh
./units/common/test.sh
./units/workflow-tests/test.sh
./units/queue-worker-tests/test.sh
./units/actor-tests/test.sh
```

There is no repository-wide Prettier command. Type checking is suite-specific through each TypeScript build.

See [Testing](testing.md) before interpreting a successful shell exit as a passing suite.

## macOS libpq troubleshooting

If Cargo cannot find the PostgreSQL client library, install and link `libpq`:

```sh
brew install postgresql
brew install libpq
brew link --force libpq
```

Then rebuild:

```sh
cargo clean
cargo build
```

If the library is still not found, add its library directory to `~/.cargo/config.toml`:

```toml
[env]
LIBRARY_PATH = "/opt/homebrew/opt/libpq/lib"
```

Run `brew --prefix libpq` and use its `lib` directory instead of the example path when Homebrew uses a different prefix.

Historical troubleshooting discussion: [libpq library not found](https://chatgpt.com/share/698ccc50-aea8-800e-b2d2-fb27cb695f0d).

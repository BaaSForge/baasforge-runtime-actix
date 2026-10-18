# BaaSForge Runtime

The BaaSForge runtime executes API, workflow, queue-worker, and actor units. It is a Rust and Actix service with a QuickJS JavaScript runtime.

This repository is the execution plane. The [BaaSForge backend](https://github.com/BaaSForge/baasforge-backend-actix) is the control plane. Both applications must connect to the same main PostgreSQL database and NATS deployment subjects.

## Naming

`baal` is the former platform name. The current name is `BaaSForge`.

Some technical identifiers still use the old name for compatibility. Examples include the `baal-runtime-actix` binary and crate, `BAAL_*` environment variables, `__baal_*` QuickJS host functions, `baal.*` telemetry attributes, and some database or container names. Treat these as historical identifiers, not the current product name. Do not rename them without a compatibility migration.

## Processes

A complete deployment runs six processes:

- `baal-runtime-actix`: HTTP, WebSocket, and unit execution API.
- `workflow_worker`: resumes durable workflows.
- `queue_worker_worker`: executes queued jobs.
- `actor_worker`: processes actor mailboxes and alarms.
- `runtime_cache_listener`: invalidates release and runtime-environment caches.
- `usage_ingest_worker`: writes usage batches to the main database.

The processes communicate through PostgreSQL, Redis, and NATS JetStream. Actor state uses a separate runtime-owned PostgreSQL database.

See [Architecture](docs/architecture.md) for the service and data flows.

## Local quick start

Requirements:

- Rust toolchain with Cargo
- Node.js 22 and npm
- Docker with Compose
- PostgreSQL and Redis
- Diesel CLI 2.3.x for Actor migrations

The repository Compose file starts NATS and the development nginx load balancer. PostgreSQL and Redis must already be available, typically from the local backend stack.

```sh
cp .env .env.local
# Set local connection values in .env.local.
docker compose up -d
./actors-migration-up.sh
./dev-scaled.sh
```

Use `http://localhost:1500` to reach the two API instances through nginx. Run `./dev-stop.sh` to stop local Rust processes.

The current development scripts do not hot-reload. Restart the affected script after a source change.

See [Local development](docs/local-development.md) for setup, backend connectivity, workers, migrations, and checks.

## Production

Production requires persistent PostgreSQL, Actor PostgreSQL, Redis, and NATS JetStream. Build and run the main image and all five worker images. Put an external TLS reverse proxy or load balancer in front of port `1501`.

See [Production and self-hosting](docs/running.md) for Docker, environment, migration, CI/CD, and rollback details.

> **Security: Values in the tracked environment and Compose files are local-development defaults. Override every credential, connection URL, and private key in staging and production. Do not deploy the tracked values.**

## Tests

```sh
./test.sh
./units/runtime-check/test.sh
./units/api-tests/test.sh
./units/common/test.sh
./units/workflow-tests/test.sh
./units/queue-worker-tests/test.sh
./units/actor-tests/test.sh
```

The integration suites report product health in JSON and `.output.log` files. Some suite scripts can exit with status 0 when their report contains failures. Inspect the report summary.

See [Testing](docs/testing.md) for coverage and limits.

## Documentation

- [Architecture](docs/architecture.md)
- [Local development](docs/local-development.md)
- [API and development conventions](docs/conventions.md)
- [Production and self-hosting](docs/running.md)
- [Testing](docs/testing.md)
- [Database migrations](docs/db-migrations.md)
- [Contributing](CONTRIBUTING.md)

## License

See [LICENSE](LICENSE).

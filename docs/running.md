# Production and self-hosting

## Required services

Run persistent instances of:

- the backend-owned PostgreSQL database
- a separate Actor PostgreSQL database
- Redis
- NATS with JetStream

The runtime also requires a running [BaaSForge backend](https://github.com/BaaSForge/baasforge-backend-actix). See [Architecture](architecture.md) for the connection contract.

Enable persistence for Redis state and JetStream data. Do not use a Redis eviction policy that can remove workflow or Actor state.

## Processes and images

A complete deployment runs six containers:

| Process | Dockerfile | Public port |
| --- | --- | --- |
| `baal-runtime-actix` | `Dockerfile` | `1501` |
| `workflow_worker` | `docker/Dockerfile.workflow_worker` | none |
| `runtime_cache_listener` | `docker/Dockerfile.runtime_cache_listener` | none |
| `queue_worker_worker` | `docker/Dockerfile.queue_worker_worker` | none |
| `actor_worker` | `docker/Dockerfile.actor_worker` | none |
| `usage_ingest_worker` | `docker/Dockerfile.usage_ingest_worker` | none |

Build the API image with `Dockerfile`. Build each worker with its named Dockerfile. Pass `APP_ENV=PROD` or `APP_ENV=STAGE` as a build argument.

The API image contains the Diesel CLI and Actor migrations because CI uses it for migration jobs. Worker images contain only their worker binary and runtime dependencies.

The API image has an HTTP health check on port `1501`. The worker images do not define health checks.

## Manual Docker deployment

Build all images from the same commit:

```sh
docker build --build-arg APP_ENV=PROD -t baasforge-runtime:VERSION .
docker build -f docker/Dockerfile.workflow_worker --build-arg APP_ENV=PROD -t baasforge-workflow-worker:VERSION .
docker build -f docker/Dockerfile.runtime_cache_listener --build-arg APP_ENV=PROD -t baasforge-cache-listener:VERSION .
docker build -f docker/Dockerfile.queue_worker_worker --build-arg APP_ENV=PROD -t baasforge-queue-worker:VERSION .
docker build -f docker/Dockerfile.actor_worker --build-arg APP_ENV=PROD -t baasforge-actor-worker:VERSION .
docker build -f docker/Dockerfile.usage_ingest_worker --build-arg APP_ENV=PROD -t baasforge-usage-ingest-worker:VERSION .
```

Create a protected env file outside the repository. Make its database, Redis, and NATS hosts reachable from the containers. Then:

```sh
docker network create baasforge

docker run --rm --network baasforge --env-file /secure/runtime.env \
  baasforge-runtime:VERSION sh -lc \
  'diesel migration run --config-file diesel-actors.toml --migration-dir migrations/actors --database-url "$ACTOR_DATABASE_URL"'

docker run -d --name baasforge-runtime --restart unless-stopped \
  --network baasforge --env-file /secure/runtime.env -p 1501:1501 \
  baasforge-runtime:VERSION
docker run -d --name baasforge-workflow-worker --restart unless-stopped \
  --network baasforge --env-file /secure/runtime.env baasforge-workflow-worker:VERSION
docker run -d --name baasforge-cache-listener --restart unless-stopped \
  --network baasforge --env-file /secure/runtime.env baasforge-cache-listener:VERSION
docker run -d --name baasforge-queue-worker --restart unless-stopped \
  --network baasforge --env-file /secure/runtime.env baasforge-queue-worker:VERSION
docker run -d --name baasforge-actor-worker --restart unless-stopped \
  --network baasforge --env-file /secure/runtime.env baasforge-actor-worker:VERSION
docker run -d --name baasforge-usage-ingest-worker --restart unless-stopped \
  --network baasforge --env-file /secure/runtime.env baasforge-usage-ingest-worker:VERSION
```

Replace `VERSION` with one immutable release version. On an existing host, remove or rename old containers before reusing these names. Use an orchestrator when you need rolling replacement, health-based recovery, or multiple replicas.

## Environment

At build time, the Dockerfiles copy `.env.prod` or `.env.stage` to `.env` in the image. At runtime, process environment variables take precedence over values loaded from that file.

The included GitHub Actions workflow overrides:

- database URLs
- Redis URLs
- NATS URLs
- the OTLP endpoint
- `RUNTIME_PRIVATE_API_KEY`

Review all other settings before deployment. Do not depend on a tracked fallback value.

> **Security: All credentials, private keys, and connection URLs in tracked environment and Compose files are local-development defaults. Override them in staging and production. Never deploy the tracked credentials.**

Required configuration includes:

- `DATABASE_URL` and its pool settings
- `ACTOR_DATABASE_URL` and its pool settings
- cache, workflow, queue-worker, and Actor Redis URLs
- general, workflow, queue-worker, Actor, release, runtime-environment, and usage NATS settings
- `RUNTIME_PRIVATE_API_KEY`
- `PORT=1501` for the API

Use a secrets manager or protected CI environment. Do not commit production values.

## Reverse proxy and TLS

Expose only the API container. Put a production reverse proxy or load balancer in front of port `1501` and configure:

- TLS termination
- WebSocket upgrades
- request and idle timeouts suitable for unit execution
- health checks and connection limits

`nginx.dev.conf` is not a production configuration. It routes to host ports `1501` and `1502` and does not configure TLS. This repository does not provide production nginx, DNS, or certificate automation.

## Actor migrations

Actor PostgreSQL is the only database migrated by this repository:

```sh
./actors-migration-up.sh
```

Run migrations before new application and worker containers. Do not run these migrations against `DATABASE_URL`.

To revert the most recent Actor migration:

```sh
./actors-migration-down.sh
```

A schema rollback can destroy or make newer data unreadable. Stop affected writers, verify the `down.sql`, back up the database, and coordinate the image rollback.

See [Database migrations](db-migrations.md).

## Included CI/CD

`.github/workflows/deploy.yml` runs for tags matching:

- `vX.Y.Z-prod.N`
- `vX.Y.Z-stage.N`

It also supports manual deployment of an existing matching tag.

The workflow:

1. Resolves the target GitHub Environment.
2. Builds and pushes the API and five worker images to GHCR.
3. Runs pending Actor migrations on the deployment host.
4. Replaces the six containers sequentially over SSH.
5. Optionally runs integration suites in the API image.
6. Reverts Actor migrations applied by that run if deployment or enabled integration tests fail.

Deployment targets and credentials come from GitHub Environment secrets. The current workflow is written for its configured remote Docker host. Adapt the SSH and host settings for another server.

### Checks that CI runs

- Docker release builds run by default.
- Actor migrations run by default.
- Integration tests are present but `RUN_TESTS` defaults to `false`.

### Checks that CI does not run

- `cargo fmt --check`
- `cargo clippy`
- `cargo test`
- repository-wide Prettier
- a repository-wide TypeScript type check
- pull-request checks

Run local quality checks before creating a release tag.

### Rollback limits

The workflow can revert Actor migrations applied during its run. It does not:

- restore the previous application or worker images
- provide blue/green deployment
- make a failed container replacement atomic
- migrate or roll back the backend-owned main database

Keep the previous image tag and a tested container command available. An operator must redeploy that tag when application rollback is required.

## Observability

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP collector. `deploy/otel-collector.yaml` is an example collector-to-Jaeger configuration.

For a local example only:

```sh
docker compose -f compose.telemetry.yml up -d
```

See [Distributed tracing](distributed-tracing.md) for trace behavior and attributes.

## Release checklist

1. Run formatting, Clippy, Rust tests, and affected `units/` suites.
2. Back up Actor PostgreSQL before a destructive migration.
3. Confirm that all production secrets override tracked values.
4. Confirm Redis and JetStream persistence.
5. Confirm the reverse proxy supports WebSockets.
6. Deploy and verify the API health check.
7. Verify all worker containers and message consumers.
8. Inspect integration JSON reports when tests are enabled.

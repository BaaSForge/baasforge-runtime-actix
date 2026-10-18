# Contributing

Thank you for contributing to the BaaSForge runtime.

## Before you start

Read:

- [Architecture](docs/architecture.md)
- [Local development](docs/local-development.md)
- [API and development conventions](docs/conventions.md)
- [Testing](docs/testing.md)
- [Database migrations](docs/db-migrations.md)

The [BaaSForge backend](https://github.com/BaaSForge/baasforge-backend-actix) owns the control-plane schema. Do not add main-database migrations here. This repository owns only Actor database migrations.

## Development workflow

1. Configure `.env.local`. It overrides `.env`.
2. Start the required PostgreSQL and Redis services.
3. Run `docker compose up -d` for NATS and the development load balancer.
4. Apply Actor migrations with `./actors-migration-up.sh`.
5. Start one process or the scaled stack as described in [Local development](docs/local-development.md).
6. Restart the affected process after code changes. Hot reload is not enabled.

## Required checks

Run the checks that match your change:

```sh
cargo fmt --all -- --check
CARGO_BUILD_RUSTC_WRAPPER= cargo clippy --all-targets
./test.sh
```

Use `./clippy-fix.sh` to apply safe Clippy fixes. Run the applicable `units/*/test.sh` integration suites for runtime behavior changes.

TypeScript test units use their suite build scripts and `tsc`. There is no repository-wide Prettier command. Do not claim that formatting, Clippy, Rust tests, or type checks ran unless you ran them locally.

## Contract rules

- Use `snake_case` for new or changed public API and WebSocket JSON keys.
- Use `crate::libs::ids::new_uuid()` for new Rust entity IDs.
- Use UUID v7 for entity-table `id` primary keys. Do not add integer or auto-incrementing IDs.
- Keep injected QuickJS SDK code as a thin proxy to Rust host functions. Do not call internal trigger routes through `fetch()`.
- Define shared `sdk.*` helpers once in `src/libs/unit_js/scripts/runtime-shared.js`.

See [API and development conventions](docs/conventions.md) for compatibility details and enforcement.

## Test changes

- Put product-level behavior tests in the matching `units/` suite.
- Keep each suite self-contained. Add its required fixture units inside that suite.
- Scope concurrent assertions by project, stage, instance, run, or actor ID.
- Inspect the generated JSON summary and `.output.log`. Some shell runners do not return a failing status for failed assertions.

See [Testing](docs/testing.md) for commands, coverage, and known limits.

## Actor migrations

Create Actor migrations only for the database referenced by `ACTOR_DATABASE_URL`:

```sh
diesel migration generate \
  --config-file diesel-actors.toml \
  --migration-dir migrations/actors \
  migration_name
```

Provide reversible `up.sql` and `down.sql` files. Test both:

```sh
./actors-migration-up.sh
./actors-migration-down.sh
./actors-migration-up.sh
```

Never point these commands at the main backend database.

## Pull requests

- Keep the change focused.
- Describe affected processes and infrastructure.
- List the checks and suites that you ran.
- Document new environment variables without adding production secrets.
- Update operational documentation when behavior, deployment, or migrations change.

> **Security: Tracked environment and Compose credentials are for local development only. Production and staging must override all credentials, connection URLs, and private keys.**

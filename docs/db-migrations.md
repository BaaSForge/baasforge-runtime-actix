# Database migrations

The runtime connects to two PostgreSQL databases. They have different owners and migration rules.

New entity tables with an `id` primary key use UUID v7. Runtime state tables can use documented composite natural keys. See [API and development conventions](conventions.md).

## Main database

`DATABASE_URL` points to the database owned by [baasforge-backend-actix](https://github.com/BaaSForge/baasforge-backend-actix).

This repository consumes its Diesel schema from `src/schema.rs`. Do not create or run main-database migrations here. Apply those migrations through the backend repository.

After the backend schema changes, regenerate the local schema view when required:

```sh
diesel print-schema \
  --config-file diesel.toml \
  --database-url "$DATABASE_URL"
```

Review generated changes before commit.

## Actor database

`ACTOR_DATABASE_URL` points to a separate database owned by this runtime. It stores:

- `actor_snapshots`
- `actor_alarms`

Actor migrations are under `migrations/actors/`. `diesel-actors.toml` generates `src/actor_schema.rs`.

### Apply

```sh
./actors-migration-up.sh
```

### Revert the latest migration

```sh
./actors-migration-down.sh
```

### Create

```sh
diesel migration generate \
  --config-file diesel-actors.toml \
  --migration-dir migrations/actors \
  migration_name
```

Write both `up.sql` and `down.sql`.

### Regenerate the Actor schema

```sh
diesel print-schema \
  --config-file diesel-actors.toml \
  --database-url "$ACTOR_DATABASE_URL"
```

## Local workflow

1. Back up important Actor data.
2. Create the migration.
3. Write reversible SQL.
4. Run `./actors-migration-up.sh`.
5. Run tests that use Actor persistence.
6. Run `./actors-migration-down.sh`.
7. Apply the migration again and rerun the tests.

Never point Actor migration commands at `DATABASE_URL`.

## Production workflow

The included deployment workflow runs Actor migrations after images are built and before containers are replaced. It records how many migrations that run applied.

If deployment or enabled integration tests fail, the rollback job reverts that count. It does not restore old application images.

For a manual production rollback:

1. Stop Actor writers if the old schema is not forward-compatible.
2. Back up Actor PostgreSQL.
3. Review the migration `down.sql`.
4. Run the API image with the production `ACTOR_DATABASE_URL` and `diesel migration revert`.
5. Redeploy the compatible application and worker images.

Migration rollback can destroy data. Prefer a forward repair when a safe reverse migration is not possible.

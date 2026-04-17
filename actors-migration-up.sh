#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/load-project-env.sh"

diesel migration run \
  --config-file diesel-actors.toml \
  --migration-dir migrations/actors \
  --database-url "$ACTOR_DATABASE_URL"

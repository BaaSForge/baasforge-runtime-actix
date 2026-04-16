# DB Migrations — Hard Rules

## NEVER run migrations inside this project

`baal-runtime-actix` is a **read-only consumer** of the database schema.  
It has no `migrations/` directory and no migration tooling.  
Running `diesel migration run` here is wrong and must never happen.


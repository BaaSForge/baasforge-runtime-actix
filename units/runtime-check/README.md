### Integrity with backend project

The packages installed in the `package.json` here needs to be synced with `src/tsgo/package.json` on the backend project to make sure typescript is doing the same when LLM writes code and when the types are checked in tests here.

### Build (`npm run build`)

Single entry: `scripts/build.mjs` type-checks, emits `dist/`, and records `node_modules` types the compiler actually loads (unused packages are omitted unless listed in tsconfig `types`):

- `runtime-project-tsc-type-deps.json` — grouped by npm package

Used by `test.sh` before integration tests run.
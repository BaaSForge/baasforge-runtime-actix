### Integrity with backend project

The packages installed in the `package.json` here needs to be synced with `src/tsgo/package.json` on the backend project to make sure typescript is doing the same when LLM writes code and when the types are checked in tests here.

### Build (`npm run build`)

Single entry: `scripts/build.mjs` type-checks, emits `dist/`, and records `node_modules` types the compiler actually loads (unused packages are omitted unless listed in tsconfig `types`):

- `runtime-project-tsc-type-deps.json` — grouped by npm package

Used by `test.sh` before integration tests run.

### Library suites (`packages/qs`, …)

Each npm library gets a folder under `packages/` with:

- `index.ts` — library tests + shared `lib/suite-harness.ts`; import `./npm-shim-imports.js` so the build picks up shim specifiers
- `npm-shim-imports.ts` — **required for subpaths**: list every npm subpath the platform must load as `import "pkg/subpath";` (side-effect only). `scripts/build.mjs` reads this file and bundles each specifier into `dist/` + `npm_shims_gen.rs`. Subpaths imported only from unit/LLM code are not discovered unless they appear here. Build also emits `dist/packages/<name>/index.js` for the suite
- `test.sh` — platform e2e for this package (`scripts/suite-test.sh`)
- `test-node.sh` — node CLI for this package (`scripts/suite-test-node.sh`)

Run **all** packages: `./packages/test.sh` or `./packages/test-node.sh` (discovers every `packages/<name>/index.ts`).

Shared harness patterns: `lib/suite-harness.ts`. Shared runners: `scripts/suite-test.sh`, `scripts/suite-test-node.sh`. Latest artifacts (gitignored, per run mode): `packages/<suite>/.last-report.{node,platform}.json`, `packages/<suite>/.last-terminal.{node,platform}.txt`.
XXX email queue -> delegate, can't beat dedicated email services without a large team

XXX image / video worker -> delegate, only add libs, nothing more

---

## HTTP / Request Parsing

- `qs` — works as-is
- `cookie` — works as-is
- `statuses` — works as-is
- `formidable` — ❌ needs Node.js streams + real `fs`. Use `@mjackson/multipart-parser` (zero deps, Web Streams, CF Workers/Deno/Bun official support). Requires one platform change: expose `req` body as `ReadableStream<Uint8Array>` in `api-runtime.js`.
- `form-data` (npm) — ❌ browser export resolves to `window.FormData` which doesn't exist in QuickJS. Add a `FormData` global polyfill to the platform once (like `URL`, `Buffer`), then users use it natively.

---

## Validation / Schema

- `zod` — works as-is (prefer over joi and ajv for user code)
- `joi` — ❌ has internal Node.js path deps. Use `zod` instead.
- `ajv` — redundant given zod; skip.

---

## Utilities

- `lodash` — ❌ CJS, won't tree-shake. Use `lodash-es` instead (same API, pure ESM).
- `nanoid` — works as-is
- `semver` — works as-is
- `ms` — works as-is
- `escape-html` — works as-is

---

## Date / Time

- `dayjs` — works as-is (prefer over luxon, lighter)
- `luxon` — works as-is

---

## Templating

- `mustache` — works as-is (prefer over handlebars, simpler, pure JS)
- `handlebars` — works as-is (browser build available, heavier than mustache)

---

## HTML / Markdown

- `marked` — works as-is
- `cheerio` — ⚠️ browser export added Dec 2024, risky and heavy dep tree. Use `node-html-parser` instead (pure JS ESM, 6× faster, no deps).
- `xss` — works as-is (prefer over DOMPurify)
- `DOMPurify` — ❌ requires a real DOM. Use `xss` instead.

---

## Logging / Storage

- `logging` — handle via `__baal_*` host function in the SDK, not a JS bundle.
- `storage` — handle via `__baal_*` host function in the SDK (Rust already owns `rust-s3`).

---

## Connections

- `graphql` — works as-is
- `graphql-request` — works as-is

---

## Third Parties

- `stripe` — works as-is (use its browser export `./dist/browser/index.js`)

---

## Auth

- `jose` — works as-is (designed for Web Crypto API)
- `bcryptjs` — works as-is
- `zod` — works as-is (listed above too)
- `casl` / `@casl/ability` — works as-is (pure JS)
- `otplib` — works as-is (needs existing `node:crypto` shim)
- `oauth4webapi` — works as-is (zero deps, runtime-agnostic, recommended)
- `arctic` — works as-is (Fetch API based, runtime-agnostic)
- `openid-client` — works as-is (edge/cloudflare/workers compatible)
- `passport` — ❌ hardwired to Node.js `http.IncomingMessage` / Express middleware. Use `oauth4webapi` or `arctic` directly instead.
- `standardwebhooks` — works as-is
- `@octokit/request` — works as-is (Fetch based, browser build available)

XXX email queue -> delegate, can't beat dedicated email services without a large team

XXX image / video worker -> delegate, only add libs, nothing more

---

## Legend

- `✅ pure JS` — bundle with esbuild, works today
- `✅ global` — already polyfilled in QuickJS (ReadableStream, FormData, Blob, fetch, AbortController, TextEncoder, URL, Buffer, process, Intl…)
- `⚙️ shim: pure JS` — add a pure JS shim to `module_shims.rs`, no Rust needed
- `⚙️ shim: Rust` — needs a Rust-backed host function implementation
- `🔧 SDK host fn` — belongs as a `__baal_*` host fn in `modules/sdk.rs`, not a JS bundle
- `→` — swap to an edge-native alternative

---

## HTTP / Request Parsing

| Package | Status | Notes |
|---|---|---|
| `qs` | ✅ pure JS | |
| `cookie` | ✅ pure JS | |
| `statuses` | ✅ pure JS | |
| `formidable` | → `@mjackson/multipart-parser` | Formidable needs `req.on('data')` Node streams + real `fs`. Replacement is zero-deps, uses `ReadableStream` (already a global). Only change needed: wrap `req.__bodyText` as a `ReadableStream<Uint8Array>` in `api-runtime.js`. |
| `form-data` (npm) | ✅ global | Browser export resolves to native `FormData`, which is already a global. Users can also use `FormData` directly in `fetch()`. |
| `mime` / `mime-types` | ✅ pure JS | MIME type lookup by extension or content-type string. Needed for file upload handling, response headers. |
| `http-errors` | ✅ pure JS | Standardized HTTP error objects (`createError(404, 'Not Found')`). Reduces boilerplate in API units. |
| `path-to-regexp` | ✅ pure JS | URL pattern matching (`/users/:id`). Useful for routing helpers inside units. |

---

## Validation / Schema

| Package | Status | Notes |
|---|---|---|
| `zod` | ✅ pure JS | Preferred. Use for all schema validation, input parsing, type inference. |
| `joi` | → `zod` | Has internal Node.js path deps. |
| `ajv` | → `zod` | Redundant. JSON Schema is harder to compose than zod schemas. |
| `validator` (npm) | ✅ pure JS | String-level validators: `isEmail`, `isURL`, `isMobilePhone`, `isUUID`, etc. Complements zod for format checks. |

---

## String & Text Utilities

| Package | Status | Notes |
|---|---|---|
| `change-case` | ✅ pure JS | `camelCase`, `snakeCase`, `pascalCase`, `kebabCase`, etc. Zero deps. |
| `slugify` | ✅ pure JS | URL-safe slug generation from titles. |
| `pluralize` | ✅ pure JS | Singular/plural conversion. Useful for dynamic message generation. |
| `escape-html` | ✅ pure JS | |
| `xss` | ✅ pure JS | HTML sanitization without DOM. Prefer over DOMPurify. |
| `DOMPurify` | → `xss` | Requires a real `window.document`. |

---

## General Utilities

| Package | Status | Notes |
|---|---|---|
| `lodash-es` | ✅ pure JS | Use `lodash-es`, not `lodash` (CJS). Pure ESM, tree-shakeable. |
| `nanoid` | ✅ pure JS | Random URL-safe IDs. |
| `uuid` | ✅ pure JS | RFC-compliant UUID v4/v7. Use when format compliance is required (e.g. database foreign keys). |
| `semver` | ✅ pure JS | |
| `ms` | ✅ pure JS | |
| `p-retry` | ✅ pure JS | Retry failed promises with backoff. Zero deps. |
| `p-timeout` | ✅ pure JS | Add timeout to any promise. Zero deps. |
| `p-limit` | ✅ pure JS | Limit concurrency of parallel promises. Zero deps. |

---

## Date / Time

| Package | Status | Notes |
|---|---|---|
| `dayjs` | ✅ pure JS | Preferred. Lighter than luxon, plugin-based. |
| `luxon` | ✅ pure JS | More powerful timezone handling if needed. |
| `cron-parser` | ✅ pure JS | Parse and iterate cron expressions. Useful for scheduling logic in workflow units. |

---

## Numbers & Math

| Package | Status | Notes |
|---|---|---|
| `decimal.js` | ✅ pure JS | Arbitrary precision arithmetic. Required for financial calculations (avoids float rounding). |
| `big.js` | ✅ pure JS | Lighter alternative to decimal.js for simpler cases. |
| `dinero.js` | ✅ pure JS | Money amount + currency + arithmetic. Built on decimal.js. Use instead of raw numbers for monetary values. |

---

## Serialization / Encoding

| Package | Status | Notes |
|---|---|---|
| `js-yaml` | ✅ pure JS | YAML parse and stringify. |
| `papaparse` | ✅ pure JS | CSV parse and stringify. Has browser build. |
| `fast-xml-parser` | ✅ pure JS | XML parse and stringify. Faster than alternatives, no deps. |
| `superjson` | ✅ pure JS | JSON with support for `Date`, `BigInt`, `Map`, `Set`, `undefined`. Useful for passing rich types between units. |

---

## Compression

| Package | Status | Notes |
|---|---|---|
| `fflate` | ✅ pure JS | gzip, deflate, zip — pure JS, zero deps, works in edge. Use instead of `node:zlib`. |

---

## Templating

| Package | Status | Notes |
|---|---|---|
| `mustache` | ✅ pure JS | Preferred. Simpler, pure JS, logic-less templates. |
| `handlebars` | ✅ pure JS | Use if helpers/partials are required. Has browser build. |

---

## HTML / Markdown / Document Generation

| Package | Status | Notes |
|---|---|---|
| `marked` | ✅ pure JS | Markdown to HTML. |
| `node-html-parser` | ✅ pure JS | HTML parsing and traversal. Use instead of cheerio. 6× faster, no deps. |
| `cheerio` | → `node-html-parser` | Browser export is new (Dec 2024) and fragile. Heavy dep tree. |
| `pdf-lib` | ✅ pure JS | PDF generation and modification. Zero deps, edge-compatible. |
| `qrcode` | ✅ pure JS | QR code generation to string/buffer. Has browser build. |
| `diff` | ✅ pure JS | Text and structured diffing. Useful for audit logs, change tracking. |

---

## Search

| Package | Status | Notes |
|---|---|---|
| `fuse.js` | ✅ pure JS | In-memory fuzzy search. Zero deps. Useful for filtering lists, autocomplete. |
| `minisearch` | ✅ pure JS | In-memory full-text search with indexing. Heavier than fuse.js but more powerful for structured data. |

---

## Logging / Storage

| Package | Status | Notes |
|---|---|---|
| logging | 🔧 SDK host fn | Expose a `__baal_log` host fn. Logging from units must go through the platform so it's correlated with traces/spans. Don't bundle pino/winston. |
| storage (S3/MinIO) | 🔧 SDK host fn | Rust already owns `rust-s3`. Expose `__baal_storage_*` host fns. |

---

## Connections

| Package | Status | Notes |
|---|---|---|
| `graphql` | ✅ pure JS | Schema definition and execution. |
| `graphql-request` | ✅ pure JS | GraphQL HTTP client built on fetch. |

---

## Third Parties

| Package | Status | Notes |
|---|---|---|
| `stripe` | ✅ pure JS | Use browser export (`./dist/browser/index.js`). Officially supports CF Workers. |
| `@octokit/request` | ✅ pure JS | GitHub API client. Fetch-based, has browser build. |

---

## Auth

| Package | Status | Notes |
|---|---|---|
| `jose` | ✅ pure JS | JWT sign/verify/encrypt. Designed for Web Crypto API (already a global). |
| `bcryptjs` | ✅ pure JS | Password hashing. Pure JS bcrypt. |
| `otplib` | ✅ pure JS | TOTP/HOTP. Needs existing `node:crypto` shim. |
| `@casl/ability` | ✅ pure JS | Authorization rules engine. Pure JS. |
| `oauth4webapi` | ✅ pure JS | OAuth 2 / OIDC. Zero deps, runtime-agnostic. **Recommended** for OAuth flows. |
| `arctic` | ✅ pure JS | OAuth providers (GitHub, Google, etc.). Fetch-based, runtime-agnostic. |
| `openid-client` | ✅ pure JS | Full OIDC client. Supports edge/cloudflare/workers. |
| `standardwebhooks` | ✅ pure JS | Webhook signature verification. |
| `libphonenumber-js` | ✅ pure JS | Phone number parsing and validation. Pure JS, no deps. |
| `passport` | → `oauth4webapi` / `arctic` | Hardwired to Node.js `http.IncomingMessage` / Express middleware. Incompatible with this platform. |

---

## Missing `node:*` Shims (add to `module_shims.rs`)

These are not yet implemented and block several of the libraries above. All can be done as pure JS shims — no Rust backing needed.

| Module | Priority | What to implement |
|---|---|---|
| `node:events` | **critical** | `EventEmitter` — `on`, `off`, `emit`, `once`, `removeAllListeners`. ~80 lines of pure JS. Hundreds of libraries inherit from it. |
| `node:path` | **critical** | `join`, `resolve`, `dirname`, `basename`, `extname`, `sep`, `posix`. Pure string operations. No OS calls. ~100 lines. |
| `node:os` | high | Stubs: `tmpdir()→'/tmp'`, `platform()→'linux'`, `arch()→'x64'`, `homedir()→'/tmp'`, `EOL`. ~20 lines. |
| `node:stream` | high | `Readable`, `Writable`, `Transform`, `PassThrough`, `pipeline`. Node-style stream API (different from WHATWG streams). ~300 lines. Enables formidable-class libraries. |
| `node:string_decoder` | medium | `StringDecoder` — decodes Buffer chunks to string with multi-byte char safety. ~60 lines. Needed by `node:stream` consumers. |
| `node:assert` | medium | `assert`, `assert.ok`, `assert.equal`, `assert.deepEqual`, `assert.throws`. ~60 lines. Used by some libraries for internal checks. |
| `node:zlib` | low | Skip — use `fflate` as the user-facing library instead. Only add if a dependency chain requires it. |
| `node:http` / `node:https` | low | Stubs only — surface `STATUS_CODES` map and basic class names. Actual HTTP is owned by the Rust layer. |

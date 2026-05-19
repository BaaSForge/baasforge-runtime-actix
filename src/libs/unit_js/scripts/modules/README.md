# ES module shims (QuickJS loader)

These files are **not** evaluated at runtime startup. They are compiled on demand when user code imports them via [`module_loader.rs`](../../module_loader.rs).

| File | Resolved as |
| --- | --- |
| `sdk.js` | `@sdk` |
| `node-*.js` | matching `node:*` specifier (see [`module_shims.rs`](../../module_shims.rs)) |

Each shim re-exports globals already installed by runtime bootstrap (`buffer.js`, `crypto.js`, `url.js`, per-type `*-runtime.js`, etc.). Do not add business logic here.

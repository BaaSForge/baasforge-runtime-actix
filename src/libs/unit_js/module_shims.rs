#[path = "npm_shims_gen.rs"]
mod npm_shims_gen;

pub const SDK: &str = include_str!("scripts/modules/sdk.js");
pub const NODE_QUERYSTRING: &str = include_str!("scripts/modules/node-querystring.js");
pub const NODE_STREAM_CONSUMERS: &str = include_str!("scripts/modules/node-stream-consumers.js");
pub const NODE_TIMERS_PROMISES: &str = include_str!("scripts/modules/node-timers-promises.js");
pub const BAAL_EXT_CRYPTO: &str = include_str!("scripts/modules/node-crypto-ext.js");

pub const BAAL_EXT_CRYPTO_ALIAS: &str = "__baal_ext_crypto";

pub const BLOCKED_NODE_MODULES: &[&str] = &[
    "node:fs",
    "node:fs/promises",
    "node:net",
    "node:dns",
    "node:dgram",
    "node:http",
    "node:https",
    "node:http2",
    "node:child_process",
    "node:os",
    "node:tty",
    "node:async_hooks",
    "node:cluster",
    "node:readline",
    "node:repl",
    "node:v8",
    "node:vm",
    "node:worker_threads",
    "node:inspector",
];

/// Specifiers compiled into the process-lifetime bytecode cache at startup.
pub fn static_shim_entries() -> Vec<(&'static str, &'static str)> {
    let mut entries = vec![
        ("@sdk", SDK),
        ("node:querystring", NODE_QUERYSTRING),
        ("node:stream/consumers", NODE_STREAM_CONSUMERS),
        ("node:timers/promises", NODE_TIMERS_PROMISES),
        (BAAL_EXT_CRYPTO_ALIAS, BAAL_EXT_CRYPTO),
    ];
    for name in ["zod", "jose", "lodash-es", "qs"] {
        if let Some(src) = baal_module_source(name) {
            entries.push((name, src));
        }
    }
    entries
}

pub fn baal_module_source(name: &str) -> Option<&'static str> {
    if let Some(src) = npm_package_shim_lookup(name) {
        return Some(src);
    }
    match name {
        "node:querystring" => Some(NODE_QUERYSTRING),
        "node:stream/consumers" => Some(NODE_STREAM_CONSUMERS),
        "node:timers/promises" => Some(NODE_TIMERS_PROMISES),
        "__baal_ext_crypto" => Some(BAAL_EXT_CRYPTO),
        _ => None,
    }
}

fn npm_package_shim_lookup(name: &str) -> Option<&'static str> {
    if let Some(src) = npm_shims_gen::npm_package_shim(name) {
        return Some(src);
    }
    if let Some(stripped) = name.strip_suffix(".js") {
        return npm_shims_gen::npm_package_shim(stripped);
    }
    None
}

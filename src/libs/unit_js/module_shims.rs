pub const SDK: &str = include_str!("scripts/modules/sdk.js");
pub const NODE_QUERYSTRING: &str = include_str!("scripts/modules/node-querystring.js");
pub const NODE_STREAM_CONSUMERS: &str = include_str!("scripts/modules/node-stream-consumers.js");
pub const NODE_TIMERS_PROMISES: &str = include_str!("scripts/modules/node-timers-promises.js");
pub const BAAL_EXT_CRYPTO: &str = include_str!("scripts/modules/node-crypto-ext.js");
pub const NPM_QS: &str =
    include_str!("../../../units/runtime-check/dist/qs/node_module.js");
pub const NPM_COOKIE: &str =
    include_str!("../../../units/runtime-check/dist/cookie/node_module.js");
pub const NPM_STATUSES: &str =
    include_str!("../../../units/runtime-check/dist/statuses/node_module.js");
pub const NPM_MULTIPART_PARSER: &str =
    include_str!("../../../units/runtime-check/dist/multipart-parser/node_module.js");

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

pub fn baal_module_source(name: &str) -> Option<&'static str> {
    match name {
        "node:querystring" => Some(NODE_QUERYSTRING),
        "node:stream/consumers" => Some(NODE_STREAM_CONSUMERS),
        "node:timers/promises" => Some(NODE_TIMERS_PROMISES),
        "__baal_ext_crypto" => Some(BAAL_EXT_CRYPTO),
        "qs" => Some(NPM_QS),
        "cookie" => Some(NPM_COOKIE),
        "statuses" => Some(NPM_STATUSES),
        "@mjackson/multipart-parser" => Some(NPM_MULTIPART_PARSER),
        _ => None,
    }
}

//! ES module sources for the QuickJS loader ([`module_loader::BaalModules`]).
//!
//! Each file under [`scripts/modules/`] is a thin re-export shim loaded on demand when user
//! code imports `@sdk` or `node:*` (see [`node_module_source`]).

pub const SDK: &str = include_str!("scripts/modules/sdk.js");

pub const NODE_BUFFER: &str = include_str!("scripts/modules/node-buffer.js");
pub const NODE_UTIL: &str = include_str!("scripts/modules/node-util.js");
pub const NODE_URL: &str = include_str!("scripts/modules/node-url.js");
pub const NODE_QUERYSTRING: &str = include_str!("scripts/modules/node-querystring.js");
pub const NODE_STREAM_CONSUMERS: &str = include_str!("scripts/modules/node-stream-consumers.js");
pub const NODE_TIMERS_PROMISES: &str = include_str!("scripts/modules/node-timers-promises.js");
pub const NODE_CRYPTO: &str = include_str!("scripts/modules/node-crypto.js");

pub fn node_module_source(name: &str) -> Option<&'static str> {
    match name {
        "node:buffer" | "buffer" => Some(NODE_BUFFER),
        "node:util" => Some(NODE_UTIL),
        "node:url" => Some(NODE_URL),
        "node:querystring" => Some(NODE_QUERYSTRING),
        "node:stream/consumers" => Some(NODE_STREAM_CONSUMERS),
        "node:timers/promises" => Some(NODE_TIMERS_PROMISES),
        "node:crypto" | "crypto" => Some(NODE_CRYPTO),
        _ => None,
    }
}

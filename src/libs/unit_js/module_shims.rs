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

const HOST_SHIMS: &[(&str, &str)] = &[
    ("@sdk", SDK),
    ("node:querystring", NODE_QUERYSTRING),
    ("node:stream/consumers", NODE_STREAM_CONSUMERS),
    ("node:timers/promises", NODE_TIMERS_PROMISES),
    (BAAL_EXT_CRYPTO_ALIAS, BAAL_EXT_CRYPTO),
];

/// Every static specifier the loader can serve: host shims + all generated npm packages.
pub fn static_shim_entries() -> Vec<(&'static str, &'static str)> {
    let mut entries =
        Vec::with_capacity(HOST_SHIMS.len() + npm_shims_gen::NPM_PACKAGE_SHIMS.len());
    entries.extend_from_slice(HOST_SHIMS);
    entries.extend_from_slice(npm_shims_gen::NPM_PACKAGE_SHIMS);
    entries
}

pub fn baal_module_source(name: &str) -> Option<&'static str> {
    if let Some(src) = npm_package_shim_lookup(name) {
        return Some(src);
    }
    HOST_SHIMS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, src)| *src)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn static_shim_entries_include_every_host_and_npm_package() {
        let entries = static_shim_entries();
        let mut seen = HashSet::new();
        for (name, src) in &entries {
            assert!(!src.is_empty(), "{name} source is empty");
            assert!(seen.insert(*name), "duplicate shim specifier {name}");
            assert_eq!(
                baal_module_source(name),
                Some(*src),
                "loader lookup must return the same source as static_shim_entries for {name}"
            );
        }
        for (name, _) in HOST_SHIMS {
            assert!(seen.contains(name), "missing host shim {name}");
        }
        for (name, src) in npm_shims_gen::NPM_PACKAGE_SHIMS {
            assert!(seen.contains(name), "missing npm shim {name}");
            assert_eq!(baal_module_source(name), Some(*src));
            assert_eq!(baal_module_source(&format!("{name}.js")), Some(*src));
        }
        assert_eq!(
            entries.len(),
            HOST_SHIMS.len() + npm_shims_gen::NPM_PACKAGE_SHIMS.len()
        );
    }
}

//! Process-level flags for QuickJS cold-start mitigations.
//!
//! Read from the environment on each call so tests and the bench binary can
//! toggle behaviour without constructing [`crate::configs::Settings`].
//!
//! - `BAAL_JS_BYTECODE` — cache QuickJS module bytecode (default off)
//! - `BAAL_JS_RUNTIME_POOL` — reuse `AsyncRuntime` instances (default off)
//! - `BAAL_JS_POOL_SIZE` — max pooled runtimes (default 8)

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

pub fn bytecode_enabled() -> bool {
    env_bool("BAAL_JS_BYTECODE", false)
}

pub fn runtime_pool_enabled() -> bool {
    env_bool("BAAL_JS_RUNTIME_POOL", false)
}

pub fn pool_size() -> usize {
    std::env::var("BAAL_JS_POOL_SIZE")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(8)
}

/// Included in bytecode cache keys; bump if the QuickJS / rquickjs build changes.
pub fn engine_id() -> &'static str {
    "rquickjs-0.11"
}

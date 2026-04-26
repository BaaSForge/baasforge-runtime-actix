use std::sync::Once;
use tracing_log::LogTracer;
use tracing_subscriber::filter::{EnvFilter, LevelFilter};

static INIT_TRACING: Once = Once::new();

/// Initializes `tracing` for stderr. Honors `RUST_LOG`; if unset, defaults to `info` (same spirit as `fmt::init()`).
/// Bridges the `log` crate (used by QuickJS `console.log` via `rquickjs-extra-console`) into tracing.
/// Safe to call from multiple entrypoints: only the first call installs the subscriber.
pub fn init_tracing() {
    INIT_TRACING.call_once(|| {
        let _ = LogTracer::init();
        let filter = EnvFilter::builder()
            .with_default_directive(LevelFilter::INFO.into())
            .from_env_lossy();
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .try_init();
    });
}

pub mod actor_schema;
pub mod configs;
pub mod database;
pub mod libs;
pub mod middlewares;
pub mod models;
pub mod routes;
pub mod schema;
pub mod services;

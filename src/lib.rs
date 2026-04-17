use tracing_subscriber::filter::{EnvFilter, LevelFilter};

/// Initializes `tracing` for stdout. Honors `RUST_LOG`; if unset, defaults to `info` (same spirit as `fmt::init()`).
/// Call once per process (each binary `main`).
pub fn init_tracing() {
    let filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .from_env_lossy();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init();
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

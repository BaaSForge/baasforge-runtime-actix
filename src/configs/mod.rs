//! Application configuration loaded from environment variables.
//!
//! Do not add in-code defaults for settings (`unwrap_or`, `unwrap_or_else`, etc.).
//! Every variable the process needs must be set explicitly in `.env` (or the environment).
//! Load order: `.env` first (base), then `.env.local` overrides if present.

use dotenvy::from_filename;
use dotenvy::from_filename_override;
use std::env;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AppEnvironment {
    #[default]
    Staging,
    Production,
}

impl TryFrom<String> for AppEnvironment {
    type Error = String;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        match s.to_lowercase().as_str() {
            "staging" => Ok(AppEnvironment::Staging),
            "production" => Ok(AppEnvironment::Production),
            _ => Err("Invalid APP_ENV. Must be 'staging' or 'production'".to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub port: String,
    pub app_environment: AppEnvironment,
    pub pg_database_url: String,
    /// Per-process pool size. Total DB connections = (API_replicas + worker_replicas) × this. Keep under PostgreSQL max_connections.
    pub database_pool_size: u32,
    pub database_connection_timeout_secs: u64,
    /// Max Tokio blocking threads for `web::block` (API unit JS + sync SDK). Set via `API_WORKER_MAX_BLOCKING_THREADS`.
    pub api_worker_max_blocking_threads: usize,
    pub redis_url: String,
    /// When false, no Redis connection is opened for cache (API / runtime_cache_listener); all project release/unit paths hit Postgres only.
    pub redis_cache_enabled: bool,
    pub nats_url: Option<String>,
    pub nats_subject_release: Option<String>,
    /// JetStream stream name (must not contain `.`). Used by the `runtime_cache_listener` binary.
    pub nats_jetstream_stream_release: Option<String>,
    /// Durable pull consumer name shared by all `runtime_cache_listener` replicas (queue-style load balancing).
    pub nats_jetstream_consumer_release: Option<String>,
    /// JetStream subject for runtime env cache invalidation (`runtime_cache_listener` binary).
    pub nats_subject_runtime_env: Option<String>,
    pub nats_jetstream_stream_runtime_env: Option<String>,
    pub nats_jetstream_consumer_runtime_env: Option<String>,

    // -- Workflow runtime infrastructure --

    /// Dedicated Redis URL for workflow state persistence (step results, promises, timers).
    pub wf_redis_url: Option<String>,
    /// NATS URL used by the workflow runtime for wake signals (sleep timers, promise resolution).
    pub wf_nats_url: Option<String>,
    /// JetStream stream name for durable workflow wake timers. Default: `"WF_WAKE"`.
    pub wf_nats_jetstream_stream: Option<String>,
    /// Durable pull consumer name shared by all `workflow_worker` replicas. Default: `"wf_wake_consumer"`.
    pub wf_nats_jetstream_consumer: Option<String>,

    // -- Queue worker runtime infrastructure --

    /// Dedicated Redis URL for queue worker state (run metadata, results, execution locks).
    pub wq_redis_url: Option<String>,
    /// NATS URL for queue worker work queue (JetStream) and lifecycle events (Core).
    pub wq_nats_url: Option<String>,

    // -- Test mode --

    /// When true, the server seeds deterministic test entities (project, runtime, release, units)
    /// on startup and tears them down on shutdown. Requires `APP_ENV=production`.
    pub test_mode: bool,
    /// Comma-separated list of `label=path` entries pointing to compiled JS files whose contents
    /// are injected as unit rows. Example: `runtime-check=units/runtime-check/dist/index.js`.
    pub test_unit_files: Vec<TestUnitFile>,
    /// Directory containing compiled workflow JS files to register as workflow units.
    /// Files are discovered recursively; the path relative to this dir determines the unit slug.
    pub test_workflow_dir: Option<String>,
    /// Directory containing compiled queue worker JS files to register as queue_worker units.
    /// Files are discovered recursively; the relative path (without .js) becomes the unit_name_slug.
    pub test_queue_worker_dir: Option<String>,

    // -- Actor runtime infrastructure --

    pub actor_database_url: Option<String>,
    pub actor_database_pool_size: u32,
    pub actor_database_connection_timeout_secs: u64,
    pub actor_redis_url: Option<String>,
    pub actor_nats_url: Option<String>,
    pub actor_nats_jetstream_stream: Option<String>,
    pub actor_nats_jetstream_consumer: Option<String>,
    pub actor_lease_ttl_secs: u64,
    pub actor_idle_sweep_secs: u64,
    pub actor_pg_flush_interval_secs: u64,

    pub otel_exporter_otlp_endpoint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TestUnitFile {
    pub label: String,
    pub path: String,
}

impl Settings {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        from_filename(".env").ok();
        from_filename_override(".env.local").ok();

        let app_env_str = env::var("APP_ENV").expect("APP_ENV must be set");
        let app_environment = AppEnvironment::try_from(app_env_str)?;

        let port = env::var("PORT").expect("PORT must be set");
        let pg_database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let database_pool_size: u32 = env::var("DATABASE_POOL_SIZE")
            .expect("DATABASE_POOL_SIZE must be set")
            .parse()
            .expect("DATABASE_POOL_SIZE must be a valid u32");
        let database_connection_timeout_secs: u64 = env::var("DATABASE_CONNECTION_TIMEOUT_SECS")
            .expect("DATABASE_CONNECTION_TIMEOUT_SECS must be set")
            .parse()
            .expect("DATABASE_CONNECTION_TIMEOUT_SECS must be a valid u64");
        let api_worker_max_blocking_threads: usize = env::var("API_WORKER_MAX_BLOCKING_THREADS")
            .expect("API_WORKER_MAX_BLOCKING_THREADS must be set")
            .parse()
            .expect("API_WORKER_MAX_BLOCKING_THREADS must be a valid usize");

        let redis_cache_enabled = match env::var("REDIS_CACHE_ENABLED") {
            Ok(s) => parse_env_bool(&s).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?,
            Err(_) => true,
        };

        let redis_url = env::var("REDIS_URL").expect("REDIS_URL must be set");

        let nats_url = env::var("NATS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let nats_subject_release = env::var("NATS_SUBJECT_RELEASE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        match (&nats_url, &nats_subject_release) {
            (Some(_), Some(_)) | (None, None) => {}
            _ => {
                return Err(
                    "NATS_URL and NATS_SUBJECT_RELEASE must both be set or both omitted"
                        .into(),
                );
            }
        }

        let nats_jetstream_stream_release = env::var("NATS_JETSTREAM_STREAM_RELEASE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let nats_jetstream_consumer_release = env::var("NATS_JETSTREAM_CONSUMER_RELEASE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let nats_subject_runtime_env = env::var("NATS_SUBJECT_RUNTIME_ENV")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let nats_jetstream_stream_runtime_env = env::var("NATS_JETSTREAM_STREAM_RUNTIME_ENV")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let nats_jetstream_consumer_runtime_env = env::var("NATS_JETSTREAM_CONSUMER_RUNTIME_ENV")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        match (&nats_url, &nats_subject_runtime_env) {
            (Some(_), Some(_)) | (None, None) => {}
            _ => {
                return Err(
                    "NATS_URL and NATS_SUBJECT_RUNTIME_ENV must both be set"
                        .into(),
                );
            }
        }

        let wf_redis_url = env::var("WF_REDIS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let wf_nats_url = env::var("WF_NATS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let wf_nats_jetstream_stream = env::var("WF_NATS_JETSTREAM_STREAM")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let wf_nats_jetstream_consumer = env::var("WF_NATS_JETSTREAM_CONSUMER")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let wq_redis_url = env::var("WQ_REDIS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let wq_nats_url = env::var("WQ_NATS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let test_mode = match env::var("TEST_MODE") {
            Ok(s) => parse_env_bool(&s).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?,
            Err(_) => false,
        };

        let test_unit_files: Vec<TestUnitFile> = env::var("TEST_UNIT_FILES")
            .ok()
            .map(|s| {
                s.split(',')
                    .filter_map(|entry| {
                        let entry = entry.trim();
                        let (label, path) = entry.split_once('=')?;
                        Some(TestUnitFile {
                            label: label.trim().to_string(),
                            path: path.trim().to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let test_workflow_dir = env::var("TEST_WORKFLOW_DIR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let test_queue_worker_dir = env::var("TEST_QUEUE_WORKER_DIR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let actor_database_url = env::var("ACTOR_DATABASE_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let actor_database_pool_size: u32 = env::var("ACTOR_DATABASE_POOL_SIZE")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(5);
        let actor_database_connection_timeout_secs: u64 =
            env::var("ACTOR_DATABASE_CONNECTION_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(5);
        let actor_redis_url = env::var("ACTOR_REDIS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let actor_nats_url = env::var("ACTOR_NATS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let actor_nats_jetstream_stream = env::var("ACTOR_NATS_JETSTREAM_STREAM")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let actor_nats_jetstream_consumer = env::var("ACTOR_NATS_JETSTREAM_CONSUMER")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let actor_lease_ttl_secs: u64 = env::var("ACTOR_LEASE_TTL_SECS")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(30);
        let actor_idle_sweep_secs: u64 = env::var("ACTOR_IDLE_SWEEP_SECS")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(60);
        let actor_pg_flush_interval_secs: u64 = env::var("ACTOR_PG_FLUSH_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(30);

        let otel_exporter_otlp_endpoint = env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Ok(Settings {
            port,
            app_environment,
            pg_database_url,
            database_pool_size,
            database_connection_timeout_secs,
            api_worker_max_blocking_threads,
            redis_url,
            redis_cache_enabled,
            nats_url,
            nats_subject_release,
            nats_jetstream_stream_release,
            nats_jetstream_consumer_release,
            nats_subject_runtime_env,
            nats_jetstream_stream_runtime_env,
            nats_jetstream_consumer_runtime_env,
            wf_redis_url,
            wf_nats_url,
            wf_nats_jetstream_stream,
            wf_nats_jetstream_consumer,
            wq_redis_url,
            wq_nats_url,
            test_mode,
            test_unit_files,
            test_workflow_dir,
            test_queue_worker_dir,
            actor_database_url,
            actor_database_pool_size,
            actor_database_connection_timeout_secs,
            actor_redis_url,
            actor_nats_url,
            actor_nats_jetstream_stream,
            actor_nats_jetstream_consumer,
            actor_lease_ttl_secs,
            actor_idle_sweep_secs,
            actor_pg_flush_interval_secs,
            otel_exporter_otlp_endpoint,
        })
    }
}

/// Connect to NATS, extracting user/pass from the URL if present.
/// `async_nats::connect` does NOT parse userinfo from URLs, so we must
/// extract credentials ourselves and use `ConnectOptions`.
pub async fn connect_nats(url: &str) -> Result<async_nats::Client, async_nats::ConnectError> {
    if let Ok(parsed) = url::Url::parse(url) {
        let user = parsed.username();
        let pass = parsed.password().unwrap_or("");
        if !user.is_empty() {
            let bare = format!(
                "{}://{}:{}",
                parsed.scheme(),
                parsed.host_str().unwrap_or("localhost"),
                parsed.port().unwrap_or(4222),
            );
            return async_nats::ConnectOptions::with_user_and_password(
                user.to_string(),
                pass.to_string(),
            )
            .connect(&bare)
            .await;
        }
    }
    async_nats::connect(url).await
}

/// Parses typical env truthy/falsey strings (e.g. `true`, `1`, `on`, `false`, `0`, `off`).
fn parse_env_bool(s: &str) -> Result<bool, String> {
    match s.trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!(
            "expected true/false, 1/0, yes/no, or on/off; got {:?}",
            other
        )),
    }
}

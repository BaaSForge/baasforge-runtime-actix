//! Application configuration loaded from environment variables.
//! All settings must be set via .env (or the environment); there are no defaults.
//! Load order: .env first (base), then .env.local overrides if present.

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
    pub redis_url: String,
    pub nats_url: Option<String>,
    pub nats_subject_release: Option<String>,
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

        Ok(Settings {
            port,
            app_environment,
            pg_database_url,
            database_pool_size,
            database_connection_timeout_secs,
            redis_url,
            nats_url,
            nats_subject_release,
        })
    }
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

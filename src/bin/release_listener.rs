use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::database::{establish_pool, SharedRedisConn};
use baal_runtime_actix::services::release_listener::run_release_deploy_listener;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::init();

    let settings = Settings::new().map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        e.to_string().into()
    })?;
    let (nats_url, nats_subject) = match (
        settings.nats_url.clone(),
        settings.nats_subject_release.clone(),
    ) {
        (Some(u), Some(s)) => (u, s),
        _ => {
            tracing::error!(
                "NATS_URL and NATS_SUBJECT_RELEASE must both be set for the release_listener binary"
            );
            std::process::exit(1);
        }
    };

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );

    let redis_conn: SharedRedisConn = match redis::Client::open(settings.redis_url.as_str()) {
        Ok(client) => match client.get_multiplexed_async_connection().await {
            Ok(conn) => {
                tracing::info!("[redis] connected (release_listener)");
                Some(Arc::new(Mutex::new(conn)))
            }
            Err(e) => {
                tracing::warn!(error = %e, "[redis] connection failed");
                None
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "[redis] client open failed");
            None
        }
    };

    run_release_deploy_listener(pool, redis_conn, nats_url, nats_subject).await
}

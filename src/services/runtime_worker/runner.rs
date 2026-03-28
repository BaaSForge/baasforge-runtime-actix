use crate::configs::Settings;
use crate::database::{establish_pool};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::init();

    let settings = Settings::new()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;
    let redis_client = redis::Client::open(settings.redis_url.as_str())?;
    let redis_conn = redis_client.get_multiplexed_async_connection().await?;
    let redis_conn = Arc::new(Mutex::new(redis_conn));
    info!("Connected to Redis for streaming chunks");

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );

    Ok(())
}

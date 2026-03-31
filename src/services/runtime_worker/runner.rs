use crate::configs::Settings;
use crate::database::establish_pool;
use crate::init_tracing;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing();

    let settings = Settings::new()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;
    if settings.redis_cache_enabled {
        let redis_client = redis::Client::open(settings.redis_url.as_str())?;
        let _redis_conn = redis_client.get_multiplexed_async_connection().await?;
        let _redis_conn = Arc::new(Mutex::new(_redis_conn));
        info!("Connected to Redis for streaming chunks");
    } else {
        info!("Redis skipped (REDIS_CACHE_ENABLED=false)");
    }

    let _pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );

    Ok(())
}

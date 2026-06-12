use baal_runtime_actix::configs::{spawn_usage_ingest_listener, usage_ingest_config, Settings};
use baal_runtime_actix::database::establish_pool;
use baal_runtime_actix::{init_tracing, shutdown_telemetry};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing("usage_ingest_worker");

    let settings = Settings::new().map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        e.to_string().into()
    })?;

    let config = usage_ingest_config(&settings).ok_or(
        "usage ingest config incomplete: set NATS_URL, NATS_JETSTREAM_STREAM_USAGE, NATS_SUBJECT_USAGE_BATCH, and NATS_JETSTREAM_CONSUMER_USAGE",
    )?;

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
        settings.database_pool_idle_timeout_secs,
    );

    let _listener = spawn_usage_ingest_listener(pool, config);

    tracing::info!("usage_ingest_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    tracing::info!("usage_ingest_worker shutting down");
    shutdown_telemetry();
    Ok(())
}

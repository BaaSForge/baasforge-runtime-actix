use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::database::establish_pool;
use baal_runtime_actix::init_tracing;
use baal_runtime_actix::services::queue_worker_engine::{WQ_NATS_WORK_CONSUMER, WQ_NATS_WORK_STREAM};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing();

    let settings = Settings::new().map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        e.to_string().into()
    })?;

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );

    let redis_conn = if settings.redis_cache_enabled {
        match redis::Client::open(settings.redis_url.as_str()) {
            Ok(client) => match client.get_multiplexed_async_connection().await {
                Ok(conn) => {
                    info!("[redis] cache connected");
                    Some(Arc::new(Mutex::new(conn)))
                }
                Err(e) => {
                    warn!(error = %e, "[redis] connection failed");
                    None
                }
            },
            Err(e) => {
                warn!(error = %e, "[redis] client open failed");
                None
            }
        }
    } else {
        info!("[redis] cache disabled (REDIS_CACHE_ENABLED=false)");
        None
    };

    let (Some(wq_redis_url), Some(wq_nats_url)) = (&settings.wq_redis_url, &settings.wq_nats_url)
    else {
        error!("WQ_REDIS_URL and WQ_NATS_URL must both be set");
        std::process::exit(1);
    };

    let wq_redis = {
        let client = redis::Client::open(wq_redis_url.as_str())?;
        let conn = client.get_multiplexed_async_connection().await?;
        info!("[wq_redis] queue worker Redis connected");
        Arc::new(Mutex::new(conn))
    };

    let nats = baal_runtime_actix::configs::connect_nats(wq_nats_url).await?;
    info!("[nats_wq] connected for queue worker work consumer");

    let wf_redis = if let Some(url) = &settings.wf_redis_url {
        match redis::Client::open(url.as_str()) {
            Ok(client) => match client.get_multiplexed_async_connection().await {
                Ok(conn) => {
                    info!("[wf_redis] workflow Redis connected (for sdk.callWorkflow)");
                    Some(Arc::new(Mutex::new(conn)))
                }
                Err(e) => { warn!(error = %e, "[wf_redis] connection failed"); None }
            },
            Err(e) => { warn!(error = %e, "[wf_redis] client open failed"); None }
        }
    } else { None };

    let wf_nats = if let Some(url) = &settings.wf_nats_url {
        match baal_runtime_actix::configs::connect_nats(url).await {
            Ok(nc) => { info!("[nats_wf] connected (for sdk.callWorkflow)"); Some(nc) }
            Err(e) => { warn!(error = %e, "[nats_wf] connect failed"); None }
        }
    } else { None };

    let stream_name = WQ_NATS_WORK_STREAM.to_string();
    let consumer_name = WQ_NATS_WORK_CONSUMER.to_string();

    tokio::spawn(async move {
        if let Err(e) = baal_runtime_actix::services::queue_worker_worker::runner::run_work_consumer(
            wq_redis,
            nats,
            pool,
            redis_conn,
            &stream_name,
            &consumer_name,
            wf_redis,
            wf_nats,
        )
        .await
        {
            error!(error = %e, "[queue_worker_worker] consumer exited with error");
        }
    });

    info!("queue_worker_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("queue_worker_worker shutting down");

    Ok(())
}

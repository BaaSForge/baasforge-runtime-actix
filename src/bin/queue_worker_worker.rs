use baal_runtime_actix::libs::unit_js::module_loader::init_tokio_handle;
use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::database::establish_pool;
use baal_runtime_actix::models::actor_store::build_actor_pg_pool;
use baal_runtime_actix::{init_tracing, shutdown_telemetry};
use baal_runtime_actix::routes::ActorLocks;
use baal_runtime_actix::services::queue_worker_engine::{WQ_NATS_WORK_CONSUMER, WQ_NATS_WORK_STREAM};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing("queue_worker_worker");
    init_tokio_handle(tokio::runtime::Handle::current());

    let settings = Settings::new().map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        e.to_string().into()
    })?;

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
        settings.database_pool_idle_timeout_secs,
    );

    let redis_conn = baal_runtime_actix::database::connect_shared_redis_cache(
        settings.redis_cache_enabled,
        &settings.redis_url,
    )
    .await
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

    let wq_nats_url = settings.wq_nats_url.as_deref().ok_or("WQ_NATS_URL must be set")?;

    let wq_redis = baal_runtime_actix::database::connect_redis(&settings.wq_redis_url).await?;
    info!("[wq_redis] queue worker Redis connected");

    let wf_redis = baal_runtime_actix::database::connect_redis(&settings.wf_redis_url).await?;
    info!("[wf_redis] workflow Redis connected");

    let actor_redis =
        baal_runtime_actix::database::connect_redis(&settings.actor_redis_url).await?;
    info!("[actor_redis] actor Redis connected");

    let nats = baal_runtime_actix::configs::connect_nats(wq_nats_url).await?;
    info!("[nats_wq] connected for queue worker work consumer");

    let wf_nats = if let Some(url) = &settings.wf_nats_url {
        match baal_runtime_actix::configs::connect_nats(url).await {
            Ok(nc) => { info!("[nats_wf] connected (for sdk.callWorkflow)"); Some(nc) }
            Err(e) => { warn!(error = %e, "[nats_wf] connect failed"); None }
        }
    } else { None };

    let actor_nats: Option<async_nats::Client> = if let Some(url) = settings.actor_nats_url.as_deref() {
        match baal_runtime_actix::configs::connect_nats(url).await {
            Ok(nc) => {
                info!("[nats_actor] connected (for sdk.callActor*)");
                Some(nc)
            }
            Err(e) => {
                warn!(error = %e, "[nats_actor] connect failed");
                None
            }
        }
    } else {
        info!("[nats_actor] ACTOR_NATS_URL unset; sdk.callActor* disabled in this process");
        None
    };

    let actor_js = actor_nats
        .as_ref()
        .map(|nc| async_nats::jetstream::new(nc.clone()));

    let actor_pg = settings.actor_database_url.as_ref().map(|url| {
        build_actor_pg_pool(
            url,
            settings.actor_database_pool_size.max(1),
            settings.actor_database_connection_timeout_secs.max(1),
            settings.actor_database_pool_idle_timeout_secs,
        )
    });

    let actor_locks: ActorLocks = Arc::new(Mutex::new(HashMap::new()));

    let stream_name = WQ_NATS_WORK_STREAM.to_string();
    let consumer_name = WQ_NATS_WORK_CONSUMER.to_string();

    let usage_meter = settings.usage_meter;
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
            actor_redis,
            actor_nats,
            actor_js,
            actor_pg,
            actor_locks,
            usage_meter,
        )
        .await
        {
            error!(error = %e, "[queue_worker_worker] consumer exited with error");
        }
    });

    info!("queue_worker_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("queue_worker_worker shutting down");
    shutdown_telemetry();

    Ok(())
}

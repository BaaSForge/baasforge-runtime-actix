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
    );

    let redis_conn = baal_runtime_actix::database::connect_shared_redis_cache(
        settings.redis_cache_enabled,
        &settings.redis_url,
    )
    .await
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

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

    let actor_redis: Option<baal_runtime_actix::services::actor_engine::ActorRedis> =
        if let Some(url) = settings.actor_redis_url.as_deref() {
            match redis::Client::open(url) {
                Ok(client) => match client.get_multiplexed_async_connection().await {
                    Ok(conn) => {
                        info!("[actor_redis] actor Redis connected (for sdk.callActor*)");
                        Some(conn)
                    }
                    Err(e) => {
                        warn!(error = %e, "[actor_redis] connection failed");
                        None
                    }
                },
                Err(e) => {
                    warn!(error = %e, "[actor_redis] client open failed");
                    None
                }
            }
        } else {
            info!("[actor_redis] ACTOR_REDIS_URL unset; sdk.callActor* disabled in this process");
            None
        };

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
        )
    });

    let actor_locks: ActorLocks = Arc::new(Mutex::new(HashMap::new()));

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
            actor_redis,
            actor_nats,
            actor_js,
            actor_pg,
            actor_locks,
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

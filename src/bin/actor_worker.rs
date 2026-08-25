use baal_runtime_actix::libs::unit_js::module_loader::init_tokio_handle;
use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::database::establish_pool;
use baal_runtime_actix::models::actor_store::build_actor_pg_pool;
use baal_runtime_actix::{init_tracing, shutdown_telemetry};
use baal_runtime_actix::libs::unit_js::modules::sdk::SdkCommCtx;
use baal_runtime_actix::routes::ActorLocks;
use baal_runtime_actix::services::actor_engine::{ACTOR_NATS_CONSUMER, ACTOR_NATS_STREAM};
use baal_runtime_actix::services::actor_worker::alarms::run_alarm_sweeper;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing("actor_worker");
    init_tokio_handle(tokio::runtime::Handle::current());
    baal_runtime_actix::libs::unit_js::bytecode::precompile_static_shims();

    let settings = Settings::new().map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        e.to_string().into()
    })?;

    baal_runtime_actix::configs::start_usage_publisher_if_enabled(&settings);

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

    let actor_nats_url = settings
        .actor_nats_url
        .as_deref()
        .ok_or("ACTOR_NATS_URL must be set")?;

    let actor_redis = baal_runtime_actix::database::connect_redis(&settings.actor_redis_url).await?;
    let wf_redis = baal_runtime_actix::database::connect_redis(&settings.wf_redis_url).await?;
    let wq_redis = baal_runtime_actix::database::connect_redis(&settings.wq_redis_url).await?;
    info!("[actor_redis] actor Redis connected");
    info!("[wf_redis] workflow Redis connected");
    info!("[wq_redis] queue worker Redis connected");

    let actor_nats = baal_runtime_actix::configs::connect_nats(actor_nats_url).await?;
    info!("[nats_actor] connected for actor mailbox consumer");
    let actor_js = Some(async_nats::jetstream::new(actor_nats.clone()));

    let actor_pg = settings.actor_database_url.as_ref().map(|url| {
        build_actor_pg_pool(
            url,
            settings.actor_database_pool_size.max(1),
            settings.actor_database_connection_timeout_secs.max(1),
            settings.actor_database_pool_idle_timeout_secs,
        )
    });

    let wf_nats_url = settings.wf_nats_url.as_deref();

    let (wf_nats, wf_js) = if let Some(url) = wf_nats_url {
        match baal_runtime_actix::configs::connect_nats(url).await {
            Ok(client) => {
                info!("[nats_wf] workflow NATS connected for actor reply wakes");
                let js = async_nats::jetstream::new(client.clone());
                (Some(client), Some(js))
            }
            Err(e) => {
                warn!(error = %e, "[nats_wf] connection failed; callActorDurable replies disabled");
                (None, None)
            }
        }
    } else {
        warn!("[nats_wf] WF_NATS_URL not set; callActorDurable replies disabled");
        (None, None)
    };

    let stream_name = settings
        .actor_nats_jetstream_stream
        .as_deref()
        .unwrap_or(ACTOR_NATS_STREAM)
        .to_string();
    let consumer_name = settings
        .actor_nats_jetstream_consumer
        .as_deref()
        .unwrap_or(ACTOR_NATS_CONSUMER)
        .to_string();
    let locks: ActorLocks = Arc::new(Mutex::new(HashMap::new()));

    let alarm_comm = Arc::new(SdkCommCtx {
        pool: pool.clone(),
        redis_conn: redis_conn.clone(),
        wf_redis: wf_redis.clone(),
        wf_nats: wf_nats.clone(),
        wf_js: wf_js.clone(),
        wq_redis: wq_redis.clone(),
        wq_nats: None,
        wq_js: None,
        actor_redis: actor_redis.clone(),
        actor_nats: Some(actor_nats.clone()),
        actor_js: actor_js.clone(),
        actor_pg: actor_pg.clone(),
        actor_locks: locks.clone(),
        project_id: String::new(),
        source_unit_path: String::new(),
        source_instance_id: None,
        stage_runtime_id: None,
        resolved_runtime_id: None,
        sdk_public_host: "localhost".to_string(),
        sdk_trigger_base_path: String::new(),
        usage_meter: settings.usage_meter,
    });
    tokio::spawn(async move {
        run_alarm_sweeper(alarm_comm).await;
    });

    let actor_idle_sweep = std::time::Duration::from_secs(settings.actor_idle_sweep_secs.max(1));
    let usage_meter = settings.usage_meter;
    tokio::spawn(async move {
        if let Err(e) = baal_runtime_actix::services::actor_worker::runner::run_actor_consumer(
            actor_redis,
            actor_js,
            Some(actor_nats),
            pool,
            redis_conn,
            wf_redis,
            wq_redis,
            wf_nats,
            wf_js,
            &stream_name,
            &consumer_name,
            actor_pg,
            locks,
            actor_idle_sweep,
            usage_meter,
        )
        .await
        {
            error!(error = %e, "[actor_worker] consumer exited with error");
        }
    });

    info!("actor_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("actor_worker shutting down");
    shutdown_telemetry();

    Ok(())
}

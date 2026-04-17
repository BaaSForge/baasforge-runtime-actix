use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::database::establish_pool;
use baal_runtime_actix::init_tracing;
use baal_runtime_actix::routes::ActorLocks;
use baal_runtime_actix::services::actor_engine::{ACTOR_NATS_CONSUMER, ACTOR_NATS_STREAM};
use baal_runtime_actix::services::actor_worker::alarms::run_alarm_sweeper;
use std::collections::HashMap;
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

    let actor_redis_url = settings
        .actor_redis_url
        .as_deref()
        .or(settings.wq_redis_url.as_deref());
    let actor_nats_url = settings
        .actor_nats_url
        .as_deref()
        .or(settings.wq_nats_url.as_deref());

    let (Some(actor_redis_url), Some(actor_nats_url)) = (actor_redis_url, actor_nats_url) else {
        error!("ACTOR_REDIS_URL (or WQ_REDIS_URL) and ACTOR_NATS_URL (or WQ_NATS_URL) must be set");
        std::process::exit(1);
    };

    let actor_redis = {
        let client = redis::Client::open(actor_redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        info!("[actor_redis] actor Redis connected");
        Arc::new(Mutex::new(conn))
    };

    let actor_nats = baal_runtime_actix::configs::connect_nats(actor_nats_url).await?;
    info!("[nats_actor] connected for actor mailbox consumer");
    let actor_js = Some(async_nats::jetstream::new(actor_nats.clone()));

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
    let base_url = format!("http://127.0.0.1:{}", settings.port);
    let locks: ActorLocks = Arc::new(Mutex::new(HashMap::new()));

    let alarm_redis = actor_redis.clone();
    let alarm_pool = pool.clone();
    let alarm_redis_conn = redis_conn.clone();
    let alarm_nats = Some(actor_nats.clone());
    let alarm_locks = locks.clone();
    let alarm_base_url = base_url.clone();
    tokio::spawn(async move {
        run_alarm_sweeper(
            alarm_redis,
            alarm_pool,
            alarm_redis_conn,
            alarm_nats,
            alarm_locks,
            alarm_base_url,
        )
        .await;
    });

    tokio::spawn(async move {
        if let Err(e) = baal_runtime_actix::services::actor_worker::runner::run_actor_consumer(
            actor_redis,
            actor_js,
            Some(actor_nats),
            pool,
            redis_conn,
            &stream_name,
            &consumer_name,
            &base_url,
            locks,
        )
        .await
        {
            error!(error = %e, "[actor_worker] consumer exited with error");
        }
    });

    info!("actor_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("actor_worker shutting down");

    Ok(())
}

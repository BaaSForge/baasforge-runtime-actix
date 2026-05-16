use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::database::{establish_pool, SharedRedisConn};
use baal_runtime_actix::services::env_listener::run_runtime_env_invalidate_listener;
use baal_runtime_actix::services::release_listener::run_release_deploy_listener;
use baal_runtime_actix::{init_tracing, shutdown_telemetry};
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing("runtime_cache_listener");

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
                "NATS_URL and NATS_SUBJECT_RELEASE must both be set for the runtime_cache_listener binary"
            );
            std::process::exit(1);
        }
    };

    let (jetstream_stream, jetstream_consumer) = match (
        settings.nats_jetstream_stream_release.clone(),
        settings.nats_jetstream_consumer_release.clone(),
    ) {
        (Some(stream), Some(consumer)) => (stream, consumer),
        _ => {
            tracing::error!(
                "NATS_JETSTREAM_STREAM_RELEASE and NATS_JETSTREAM_CONSUMER_RELEASE must both be set for the runtime_cache_listener binary"
            );
            std::process::exit(1);
        }
    };

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );

    let redis_conn: SharedRedisConn = if !settings.redis_cache_enabled {
        tracing::info!("[redis] cache disabled (REDIS_CACHE_ENABLED=false); skipping connection");
        None
    } else {
        match redis::Client::open(settings.redis_url.as_str()) {
            Ok(client) => match client.get_multiplexed_async_connection().await {
                Ok(conn) => {
                    tracing::info!("[redis] connected (runtime_cache_listener)");
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
        }
    };

    let release_handle = tokio::spawn({
        let pool = pool.clone();
        let redis = redis_conn.clone();
        let nats_url = nats_url.clone();
        async move {
            run_release_deploy_listener(
                pool,
                redis,
                nats_url,
                nats_subject,
                jetstream_stream,
                jetstream_consumer,
            )
            .await
        }
    });

    let env_handle = match (
        settings.nats_subject_runtime_env.clone(),
        settings.nats_jetstream_stream_runtime_env.clone(),
        settings.nats_jetstream_consumer_runtime_env.clone(),
    ) {
        (None, None, None) => None,
        (Some(env_subject), Some(env_stream), Some(env_consumer)) => {
            let redis = redis_conn.clone();
            let nats_url = nats_url.clone();
            Some(tokio::spawn(async move {
                run_runtime_env_invalidate_listener(
                    redis,
                    nats_url,
                    env_subject,
                    env_stream,
                    env_consumer,
                )
                .await
            }))
        }
        _ => {
            tracing::error!(
                "NATS_SUBJECT_RUNTIME_ENV, NATS_JETSTREAM_STREAM_RUNTIME_ENV, and NATS_JETSTREAM_CONSUMER_RUNTIME_ENV must all be set or all omitted"
            );
            std::process::exit(1);
        }
    };

    match env_handle {
        Some(env_h) => {
            let (release_res, env_res) = tokio::join!(release_handle, env_h);
            release_res??;
            env_res??;
        }
        None => {
            release_handle.await??;
        }
    }

    shutdown_telemetry();
    Ok(())
}

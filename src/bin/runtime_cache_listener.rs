use baal_runtime_actix::configs::Settings;
use baal_runtime_actix::services::env_listener::run_runtime_env_invalidate_listener;
use baal_runtime_actix::services::release_listener::run_release_deploy_listener;
use baal_runtime_actix::{init_tracing, shutdown_telemetry};
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

    let redis_conn = baal_runtime_actix::database::connect_shared_redis_cache(
        settings.redis_cache_enabled,
        &settings.redis_url,
    )
    .await
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

    let release_handle = tokio::spawn({
        let redis = redis_conn.clone();
        let nats_url = nats_url.clone();
        async move {
            if let Err(e) = run_release_deploy_listener(
                redis,
                nats_url,
                nats_subject,
                jetstream_stream,
                jetstream_consumer,
            )
            .await
            {
                tracing::error!(error = %e, "[runtime_cache_listener] release listener exited");
            }
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
                if let Err(e) = run_runtime_env_invalidate_listener(
                    redis,
                    nats_url,
                    env_subject,
                    env_stream,
                    env_consumer,
                )
                .await
                {
                    tracing::error!(error = %e, "[runtime_cache_listener] env listener exited");
                }
            }))
        }
        _ => {
            tracing::error!(
                "NATS_SUBJECT_RUNTIME_ENV, NATS_JETSTREAM_STREAM_RUNTIME_ENV, and NATS_JETSTREAM_CONSUMER_RUNTIME_ENV must all be set or all omitted"
            );
            std::process::exit(1);
        }
    };

    tracing::info!("runtime_cache_listener running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    release_handle.abort();
    if let Some(h) = env_handle {
        h.abort();
    }
    shutdown_telemetry();
    Ok(())
}

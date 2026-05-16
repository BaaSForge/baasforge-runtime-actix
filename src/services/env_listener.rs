//! NATS JetStream: invalidate cached runtime env vars when the control plane updates a key.

use crate::database::SharedRedisConn;
use crate::services::runtime_env::invalidate_env_cache;
use async_nats::jetstream;
use async_nats::jetstream::consumer::pull;
use async_nats::jetstream::stream;
use futures::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

/// Published when a runtime env var is created, updated, or deleted.
#[derive(Debug, Deserialize)]
pub struct RuntimeEnvInvalidateEvent {
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub key: String,
}

async fn handle_runtime_env_invalidate_event(redis: &SharedRedisConn, payload: &[u8]) {
    let event: RuntimeEnvInvalidateEvent = match serde_json::from_slice(payload) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(error = %e, "[nats] invalid runtime env invalidate JSON");
            return;
        }
    };

    let key = event.key.trim();
    if key.is_empty() {
        tracing::warn!(
            project_id = %event.project_id,
            runtime_id = %event.runtime_id,
            "[nats] runtime env invalidate: empty key"
        );
        return;
    }

    tracing::info!(
        project_id = %event.project_id,
        runtime_id = %event.runtime_id,
        %key,
        "[nats] runtime env invalidate event received"
    );

    if redis.is_none() {
        tracing::info!(
            project_id = %event.project_id,
            runtime_id = %event.runtime_id,
            %key,
            "[nats] redis unavailable; skipping env cache invalidation"
        );
        return;
    }

    if let Err(e) = invalidate_env_cache(redis, event.project_id, event.runtime_id, key).await {
        tracing::error!(
            error = %e,
            project_id = %event.project_id,
            runtime_id = %event.runtime_id,
            %key,
            "[nats] env cache invalidation failed"
        );
        return;
    }

    tracing::info!(
        project_id = %event.project_id,
        runtime_id = %event.runtime_id,
        %key,
        "[nats] runtime env cache invalidated"
    );
}

pub async fn run_runtime_env_invalidate_listener(
    redis: SharedRedisConn,
    nats_url: String,
    subject: String,
    jetstream_stream: String,
    consumer_name: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!("[nats] connecting for runtime env invalidate events (JetStream)");
    let client = crate::configs::connect_nats(&nats_url).await?;

    let js = jetstream::new(client);

    let stream = js
        .get_or_create_stream(stream::Config {
            name: jetstream_stream.clone(),
            subjects: vec![subject.clone()],
            ..Default::default()
        })
        .await?;

    tracing::info!(
        stream = %jetstream_stream,
        consumer = %consumer_name,
        %subject,
        "[nats] JetStream stream ready; runtime env invalidate consumer"
    );

    let consumer = stream
        .get_or_create_consumer(
            &consumer_name,
            pull::Config {
                durable_name: Some(consumer_name.clone()),
                filter_subject: subject.clone(),
                ..Default::default()
            },
        )
        .await?;

    let mut messages = consumer.messages().await?;

    while let Some(result) = messages.next().await {
        match result {
            Ok(msg) => {
                handle_runtime_env_invalidate_event(&redis, &msg.payload).await;
                if let Err(e) = msg.ack().await {
                    tracing::error!(error = %e, "[nats] jetstream ack failed");
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "[nats] jetstream consumer stream error");
            }
        }
    }

    tracing::warn!(%subject, "[nats] runtime env invalidate consumer ended");
    Ok(())
}

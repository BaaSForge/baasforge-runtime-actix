//! NATS JetStream: release deploy notifications clear all Redis unit/release cache for one runtime scope.
//!
//! Invalidation is limited to a single Redis namespace: production (`shared:units:{project_id}:prod:`) or one stage
//! runtime (`shared:units:{runtime_id}:`). A deploy event never clears other stage runtimes or production when only
//! one scope changed. **Product assumption:** one production runtime per project.
//!
//! **Publishers** must use JetStream (`jetstream.publish` / the JS API), not core NATS publish, so messages
//! are persisted and match the stream. **Consumers**: a single durable pull consumer is shared by all
//! `runtime_cache_listener` processes; each message is delivered to at most one replica.

use crate::database::SharedRedisConn;
use crate::services::project_runtime_cache::{
    clear_project_runtime_cache_on_deploy, ProjectRuntimeCacheScope,
};
use async_nats::jetstream;
use async_nats::jetstream::consumer::pull;
use async_nats::jetstream::stream;
use futures::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseDeployEnvironment {
    Production,
    Stage,
}

/// Payload published when a runtime’s live release changes (upgrade, rollback, detach, or first deploy).
#[derive(Debug, Deserialize)]
pub struct ReleaseDeployEvent {
    pub project_id: Uuid,
    pub environment: ReleaseDeployEnvironment,
    #[serde(default)]
    pub runtime_id: Option<Uuid>,
    #[serde(default)]
    pub deployed_release_id: Option<Uuid>,
    #[serde(default)]
    pub previous_release_id: Option<Uuid>,
}

fn cache_scope_for_deploy_event(event: &ReleaseDeployEvent) -> Option<ProjectRuntimeCacheScope> {
    match event.environment {
        ReleaseDeployEnvironment::Production => Some(ProjectRuntimeCacheScope::Prod),
        ReleaseDeployEnvironment::Stage => event
            .runtime_id
            .map(|runtime_id| ProjectRuntimeCacheScope::Stage { runtime_id }),
    }
}

async fn handle_release_deploy_event(redis: &SharedRedisConn, payload: &[u8]) {
    let event: ReleaseDeployEvent = match serde_json::from_slice(payload) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(error = %e, "[nats] invalid release deploy JSON");
            return;
        }
    };

    tracing::info!(
        project_id = %event.project_id,
        ?event.environment,
        runtime_id = ?event.runtime_id,
        deployed_release_id = ?event.deployed_release_id,
        previous_release_id = ?event.previous_release_id,
        "[nats] release deploy event received"
    );

    let Some(scope) = cache_scope_for_deploy_event(&event) else {
        tracing::warn!(
            project_id = %event.project_id,
            "[nats] stage deploy event requires runtime_id"
        );
        return;
    };

    if redis.is_none() {
        tracing::info!(
            project_id = %event.project_id,
            ?scope,
            "[nats] redis unavailable; skipping cache invalidation"
        );
        return;
    }

    if let Err(e) =
        clear_project_runtime_cache_on_deploy(redis, event.project_id, scope).await
    {
        tracing::error!(error = %e, "[nats] redis cache clear failed");
        return;
    }

    tracing::info!(
        project_id = %event.project_id,
        deployed_release_id = ?event.deployed_release_id,
        ?scope,
        "[nats] release deploy cache cleared for scope"
    );
}

pub async fn run_release_deploy_listener(
    redis: SharedRedisConn,
    nats_url: String,
    subject: String,
    jetstream_stream: String,
    consumer_name: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!("[nats] connecting to NATS for release deploy events (JetStream)");
    let client = crate::configs::connect_nats(&nats_url).await?;
    tracing::info!("[nats] NATS client ready for release deploy events");

    let js = jetstream::new(client);
    let mut backoff_attempt = 0usize;

    loop {
        let stream = match js
            .get_or_create_stream(stream::Config {
                name: jetstream_stream.clone(),
                subjects: vec![subject.clone()],
                ..Default::default()
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "[nats] release stream setup failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        tracing::info!(
            stream = %jetstream_stream,
            consumer = %consumer_name,
            %subject,
            "[nats] release deploy consumer reconnecting"
        );

        let consumer = match stream
            .get_or_create_consumer(
                &consumer_name,
                pull::Config {
                    durable_name: Some(consumer_name.clone()),
                    filter_subject: subject.clone(),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "[nats] release consumer setup failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        let mut messages = match consumer.messages().await {
            Ok(m) => {
                backoff_attempt = 0;
                m
            }
            Err(e) => {
                tracing::error!(error = %e, "[nats] release messages stream failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        while let Some(result) = messages.next().await {
            match result {
                Ok(msg) => {
                    handle_release_deploy_event(&redis, &msg.payload).await;
                    if let Err(e) = msg.ack().await {
                        tracing::error!(error = %e, "[nats] jetstream ack failed");
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "[nats] jetstream consumer stream error; reconnecting");
                    break;
                }
            }
        }

        tracing::warn!(%subject, "[nats] release deploy consumer stream ended; reconnecting");
        crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
    }
}

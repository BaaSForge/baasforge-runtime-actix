//! NATS JetStream: release deploy notifications drive **scoped** Redis cache invalidation for one runtime only.
//!
//! Invalidation is limited to a single Redis namespace: production (`{project_id}:prod:`) or one stage
//! runtime (`{runtime_id}:`). A deploy event never walks every runtime for a project,
//! never uses `FLUSHDB` / `KEYS`, and does not clear other stage runtimes when production changes (or vice
//! versa). **Product assumption:** one production runtime per project; prod cache keys are shared for that
//! project’s lone prod scope.
//!
//! **Publishers** must use JetStream (`jetstream.publish` / the JS API), not core NATS publish, so messages
//! are persisted and match the stream. **Consumers**: a single durable pull consumer is shared by all
//! `release_listener` processes; each message is delivered to at most one replica.

use crate::database::{DbPool, SharedRedisConn};
use crate::services::project_release::load_project_release_by_id;
use crate::services::project_runtime_cache::{
    clear_project_runtime_cache_on_deploy, ProjectRuntimeCacheScope,
};
use async_nats::jetstream;
use async_nats::jetstream::consumer::pull;
use async_nats::jetstream::stream;
use async_nats::ConnectOptions;
use futures::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseDeployEnvironment {
    Production,
    Stage,
}

/// Payload published when a runtime’s live release changes (upgrade, rollback, or first deploy).
///
/// [`ReleaseDeployEvent::deployed_release_id`] absent or `null` means the live release was detached.
/// [`ReleaseDeployEvent::previous_release_id`] identifies the row that was live before this deploy (for selective
/// Redis invalidation vs the deployed release). Omit or `null` when there was no prior live release (first deploy).
#[derive(Debug, Deserialize)]
pub struct ReleaseDeployEvent {
    pub project_id: Uuid,
    pub environment: ReleaseDeployEnvironment,
    #[serde(default)]
    pub runtime_id: Option<Uuid>,
    /// `None` / missing: detached.
    #[serde(default)]
    pub deployed_release_id: Option<Uuid>,
    /// Primary key of the release row that was live before this deploy (`project_releases.id`).
    #[serde(default)]
    pub previous_release_id: Option<Uuid>,
}

async fn handle_release_deploy_event(
    pool: &DbPool,
    redis: &SharedRedisConn,
    payload: &[u8],
) {
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

    let is_stage = matches!(event.environment, ReleaseDeployEnvironment::Stage);

    let scope = match event.environment {
        ReleaseDeployEnvironment::Production => ProjectRuntimeCacheScope::Prod,
        ReleaseDeployEnvironment::Stage => {
            let Some(runtime_id) = event.runtime_id else {
                tracing::warn!(
                    project_id = %event.project_id,
                    "[nats] stage deploy event requires runtime_id"
                );
                return;
            };
            ProjectRuntimeCacheScope::Stage { runtime_id }
        }
    };

    let Some(deployed_id) = event.deployed_release_id else {
        tracing::info!(
            project_id = %event.project_id,
            ?scope,
            "[nats] live release detached; skipping cache invalidation"
        );
        return;
    };

    if redis.is_none() {
        tracing::info!(
            project_id = %event.project_id,
            deployed_release_id = %deployed_id,
            ?scope,
            "[nats] redis unavailable; skipping cache invalidation"
        );
        return;
    }

    let live_row = if let Some(prev_id) = event.previous_release_id {
        match load_project_release_by_id(pool, event.project_id, is_stage, prev_id).await {
            Ok(Some(r)) => Some(r),
            Ok(None) => {
                tracing::warn!(
                    project_id = %event.project_id,
                    previous_release_id = %prev_id,
                    "[nats] previous_release_id not found; continuing without prior release row"
                );
                None
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    project_id = %event.project_id,
                    previous_release_id = %prev_id,
                    "[nats] failed to load previous release by id"
                );
                return;
            }
        }
    } else {
        None
    };

    let target_row = match load_project_release_by_id(pool, event.project_id, is_stage, deployed_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!(
                project_id = %event.project_id,
                deployed_release_id = %deployed_id,
                is_stage,
                "[nats] deployed release row not found"
            );
            return;
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                project_id = %event.project_id,
                deployed_release_id = %deployed_id,
                "[nats] failed to load deployed release"
            );
            return;
        }
    };

    // Single scope only: prod XOR one stage runtime — see `ProjectRuntimeCacheScope`.
    if let Err(e) = clear_project_runtime_cache_on_deploy(
        redis,
        event.project_id,
        scope,
        live_row.as_ref(),
        &target_row,
    )
    .await
    {
        tracing::error!(error = %e, "[nats] redis selective cache clear failed");
        return;
    }

    tracing::info!(
        project_id = %event.project_id,
        deployed_release_id = %deployed_id,
        deployed_revision = target_row.revision,
        previous_release_id = ?event.previous_release_id,
        ?scope,
        "[nats] release deploy cache invalidated"
    );
}

/// `async_nats::connect` does not apply user:pass from the URL to the CONNECT frame; only
/// [`ConnectOptions`] auth is sent. Use explicit options when the URL embeds credentials.
async fn connect_nats(nats_url: &str) -> Result<async_nats::Client, async_nats::ConnectError> {
    let Ok(mut parsed) = url::Url::parse(nats_url) else {
        return async_nats::connect(nats_url).await;
    };
    let user = parsed.username();
    let pass = parsed.password();
    if user.is_empty() && pass.is_none() {
        return async_nats::connect(nats_url).await;
    }
    let user = user.to_string();
    let pass = pass.unwrap_or("").to_string();
    parsed.set_username("").map_err(|()| {
        async_nats::ConnectError::from(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NATS URL: could not clear username for connect",
        ))
    })?;
    parsed.set_password(None).map_err(|()| {
        async_nats::ConnectError::from(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NATS URL: could not clear password for connect",
        ))
    })?;
    let server_url = parsed.to_string();
    ConnectOptions::new()
        .user_and_password(user, pass)
        .connect(server_url)
        .await
}

/// Runs the JetStream durable pull consumer until the connection ends. Intended for the `release_listener`
/// binary (or a dedicated task); do not drop the returned future immediately or the listener will stop.
pub async fn run_release_deploy_listener(
    pool: DbPool,
    redis: SharedRedisConn,
    nats_url: String,
    subject: String,
    jetstream_stream: String,
    consumer_name: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!("[nats] connecting to NATS for release deploy events (JetStream)");
    let client = connect_nats(&nats_url).await?;
    tracing::info!("[nats] connected to NATS");

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
        "[nats] JetStream stream ready; subscribing with durable pull consumer"
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
                handle_release_deploy_event(&pool, &redis, &msg.payload).await;
                if let Err(e) = msg.ack().await {
                    tracing::error!(error = %e, "[nats] jetstream ack failed");
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "[nats] jetstream consumer stream error");
            }
        }
    }

    tracing::warn!(%subject, "[nats] release deploy JetStream consumer ended");
    Ok(())
}

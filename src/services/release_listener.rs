//! NATS subscription: release deploy notifications drive Redis cache invalidation for the affected runtime.

use crate::database::{DbPool, SharedRedisConn};
use crate::services::project_release::{
    load_live_release_revision_for_runtime, load_project_release_by_revision, LiveReleaseRevisionSource,
};
use crate::services::project_runtime_cache::{
    clear_project_runtime_cache_full, clear_project_runtime_cache_on_deploy, ProjectRuntimeCacheScope,
};
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
/// [`ReleaseDeployEvent::deployed_revision`] absent or `null` means the live release was detached; all Redis
/// keys for that runtime scope are removed. When set, the previous live revision is inferred from
/// [`project_runtimes::live_release_revision`] at handle time. If it already equals `deployed_revision`, the
/// event is treated as a duplicate (late delivery) and ignored.
#[derive(Debug, Deserialize)]
pub struct ReleaseDeployEvent {
    pub project_id: Uuid,
    pub environment: ReleaseDeployEnvironment,
    #[serde(default)]
    pub runtime_id: Option<Uuid>,
    /// `None` / missing: detached — flush Redis for this runtime scope.
    #[serde(default)]
    pub deployed_revision: Option<i32>,
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

    let is_stage = matches!(event.environment, ReleaseDeployEnvironment::Stage);

    let (scope, rev_source) = match event.environment {
        ReleaseDeployEnvironment::Production => (
            ProjectRuntimeCacheScope::Prod,
            LiveReleaseRevisionSource::Production,
        ),
        ReleaseDeployEnvironment::Stage => {
            let Some(runtime_id) = event.runtime_id else {
                tracing::warn!(
                    project_id = %event.project_id,
                    "[nats] stage deploy event requires runtime_id"
                );
                return;
            };
            (
                ProjectRuntimeCacheScope::Stage { runtime_id },
                LiveReleaseRevisionSource::Stage { runtime_id },
            )
        }
    };

    let Some(deployed_revision) = event.deployed_revision else {
        if let Err(e) = clear_project_runtime_cache_full(redis, event.project_id, scope).await {
            tracing::error!(error = %e, "[nats] redis full cache clear (detach) failed");
            return;
        }
        tracing::info!(
            project_id = %event.project_id,
            ?scope,
            "[nats] live release detached; runtime cache cleared"
        );
        return;
    };

    let db_live_rev = match load_live_release_revision_for_runtime(pool, event.project_id, rev_source).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(
                error = %e,
                project_id = %event.project_id,
                "[nats] failed to read live_release_revision from project_runtimes"
            );
            return;
        }
    };

    if db_live_rev == Some(deployed_revision) {
        tracing::debug!(
            project_id = %event.project_id,
            deployed_revision,
            ?scope,
            "[nats] DB already at deployed_revision; ignoring duplicate deploy event"
        );
        return;
    }

    let live_row = if let Some(prev) = db_live_rev {
        match load_project_release_by_revision(pool, event.project_id, is_stage, prev).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    project_id = %event.project_id,
                    previous_revision = prev,
                    "[nats] failed to load prior live release row"
                );
                return;
            }
        }
    } else {
        None
    };

    let target_row = match load_project_release_by_revision(
        pool,
        event.project_id,
        is_stage,
        deployed_revision,
    )
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!(
                project_id = %event.project_id,
                revision = deployed_revision,
                is_stage,
                "[nats] deployed release row not found"
            );
            return;
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                project_id = %event.project_id,
                revision = deployed_revision,
                "[nats] failed to load deployed release"
            );
            return;
        }
    };

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
        deployed_revision,
        db_live_revision_before = ?db_live_rev,
        ?scope,
        "[nats] release deploy cache invalidated"
    );
}

/// Runs the NATS subscription until the connection ends. Intended for the `release_listener` binary (or a
/// dedicated task); do not drop the returned future immediately or the listener will stop.
pub async fn run_release_deploy_listener(
    pool: DbPool,
    redis: SharedRedisConn,
    nats_url: String,
    subject: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = async_nats::connect(nats_url).await?;
    let mut sub = client.subscribe(subject.clone()).await?;

    tracing::info!(%subject, "[nats] listening for release deploy events");

    while let Some(msg) = sub.next().await {
        handle_release_deploy_event(&pool, &redis, &msg.payload).await;
    }

    tracing::warn!(%subject, "[nats] release deploy subscription ended");
    Ok(())
}

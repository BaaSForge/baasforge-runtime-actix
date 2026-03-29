//! Redis cache layout for project runtime scope (prod or stage runtime) and selective invalidation on deploy.
//!
//! On deploy, the cached release row must always be dropped. Per-unit keys are removed only for full unit ids
//! that were part of the previously live release but are not in the target release’s
//! [`crate::models::projects::UnitsMetadata::combined_unit_ids`], so units unchanged across the switch keep
//! their cache.

use crate::database::SharedRedisConn;
use crate::models::projects::ProjectReleaseRow;
use redis::AsyncCommands;
use std::collections::HashSet;
use uuid::Uuid;

/// Redis cache scope: production (`{project_id}:prod:*`) or one stage runtime (`{project_id}:stage:{runtime_id}:*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRuntimeCacheScope {
    Prod,
    Stage { runtime_id: Uuid },
}

pub(crate) fn redis_scope_prefix(project_id: Uuid, scope: ProjectRuntimeCacheScope) -> String {
    match scope {
        ProjectRuntimeCacheScope::Prod => format!("{project_id}:prod:"),
        ProjectRuntimeCacheScope::Stage { runtime_id } => {
            format!("{project_id}:stage:{runtime_id}:")
        }
    }
}

pub(crate) fn redis_key_release(project_id: Uuid, scope: ProjectRuntimeCacheScope) -> String {
    format!("{}release", redis_scope_prefix(project_id, scope))
}

pub(crate) fn redis_key_unit(
    project_id: Uuid,
    scope: ProjectRuntimeCacheScope,
    full_unit_id: &str,
) -> String {
    format!(
        "{}unit:{full_unit_id}",
        redis_scope_prefix(project_id, scope)
    )
}

fn combined_full_unit_ids(release: &ProjectReleaseRow) -> HashSet<String> {
    let Some(meta) = release.units_metadata.as_ref() else {
        return HashSet::new();
    };
    meta.combined_unit_ids
        .iter()
        .map(|e| e.unit_id.clone())
        .collect()
}

/// Clears the cached release row for this scope. Removes per-unit Redis keys only for full unit ids that were
/// in `live_release` but not in `target_release` (by [`combined_unit_ids`](crate::models::projects::UnitsMetadata::combined_unit_ids)).
///
/// Call this when updating a runtime’s `live_release_revision` to `target_release.revision`, passing the
/// release row that was live **before** the update and the release row being deployed (older or newer revision).
/// If there was no prior live release, pass `live_release: None`.
pub async fn clear_project_runtime_cache_on_deploy(
    redis: &SharedRedisConn,
    project_id: Uuid,
    scope: ProjectRuntimeCacheScope,
    live_release: Option<&ProjectReleaseRow>,
    target_release: &ProjectReleaseRow,
) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(());
    };
    let mut conn = rc.lock().await;

    let release_key = redis_key_release(project_id, scope);
    let _: () = conn.del(&release_key).await?;

    let target_ids = combined_full_unit_ids(target_release);
    let live_ids = live_release
        .map(combined_full_unit_ids)
        .unwrap_or_default();

    let to_remove: Vec<String> = live_ids
        .difference(&target_ids)
        .map(|id| redis_key_unit(project_id, scope, id))
        .collect();

    for key in to_remove {
        let _: () = conn.del(&key).await?;
    }

    Ok(())
}

/// Drops every key under this runtime’s cache prefix (the cached release row and all per-unit keys).
/// Use when the live release is detached (no revision) so nothing remains stale in Redis.
pub async fn clear_project_runtime_cache_full(
    redis: &SharedRedisConn,
    project_id: Uuid,
    scope: ProjectRuntimeCacheScope,
) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    let pattern = format!("{}*", redis_scope_prefix(project_id, scope));
    let keys: Vec<String> = {
        let mut iter = conn.scan_match::<&str, String>(&pattern).await?;
        let mut keys = Vec::new();
        while let Some(key_res) = iter.next_item().await {
            keys.push(key_res?);
        }
        keys
    };
    for key in keys {
        let _: () = conn.del(&key).await?;
    }
    Ok(())
}

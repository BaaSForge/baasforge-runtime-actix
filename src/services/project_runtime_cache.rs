//! Redis cache layout for project runtime scope (prod or stage runtime) and selective invalidation on deploy.
//!
//! On deploy, the cached release row must always be dropped. Per-unit keys are removed only for entries
//! (chat session + full unit id) that were part of the previously live release but not in the target
//! release’s [`crate::models::projects::UnitsMetadata::combined_unit_ids`]. Unit keys include
//! [`crate::models::projects::UnitIdEntry::chat_session_id`] so the same full unit id string in different
//! stage chat sessions does not share one Redis entry.

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
    chat_session_id: Uuid,
    full_unit_id: &str,
) -> String {
    format!(
        "{}unit:{}:{}",
        redis_scope_prefix(project_id, scope),
        chat_session_id,
        full_unit_id
    )
}

fn combined_unit_cache_entries(release: &ProjectReleaseRow) -> HashSet<(Uuid, String)> {
    let Some(meta) = release.units_metadata.as_ref() else {
        return HashSet::new();
    };
    meta.combined_unit_ids
        .iter()
        .map(|e| (e.chat_session_id, e.unit_id.clone()))
        .collect()
}

/// Clears the cached release row for this scope. Removes per-unit Redis keys only for `(chat_session_id,
/// full_unit_id)` pairs that were in `live_release` but not in `target_release` (via
/// [`UnitsMetadata::combined_unit_ids`](crate::models::projects::UnitsMetadata::combined_unit_ids)).
///
/// Call when the runtime’s live release pointer changes, passing the release row that was live **before** the
/// update and the release row being deployed. If there was no prior live release, pass `live_release: None`.
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

    let target_entries = combined_unit_cache_entries(target_release);
    let live_entries = live_release
        .map(combined_unit_cache_entries)
        .unwrap_or_default();

    let to_remove: Vec<String> = live_entries
        .difference(&target_entries)
        .map(|(chat_id, uid)| redis_key_unit(project_id, scope, *chat_id, uid))
        .collect();

    for key in to_remove {
        let _: () = conn.del(&key).await?;
    }

    Ok(())
}

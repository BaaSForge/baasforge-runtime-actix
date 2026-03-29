//! Latest project release loading (Redis + Postgres) and unit resolution from release metadata.
//!
//! **Full unit id vs unit path:** A *full unit id* is
//! `context_slug.module_slug.unit_type_slug.unit_name_slug.revision` (five dot-separated segments; the last
//! segment is the numeric revision). A *unit path* omits that final segment (four segments). APIs and release
//! [`crate::models::projects::UnitsMetadata`] entries match on the path; [`crate::schema::project_units`].`id`
//! stores the **full** id string — never use a path where the DB expects a full unit id.

use crate::database::{block_on_db, BlockingDbError, DbPool, SharedRedisConn};
use crate::models::projects::{
    PlatformEnvironmentType, ProjectReleaseRow, ProjectUnitRow, ProjectUnitType,
};
use crate::schema::{project_releases, project_runtimes, project_units};
use crate::services::project_runtime_cache::{
    ProjectRuntimeCacheScope, redis_key_release, redis_key_unit,
};
use diesel::prelude::*;
use diesel::OptionalExtension;
use redis::AsyncCommands;
use serde::Serialize;
use uuid::Uuid;

/// How to resolve which release row to load: production (first prod runtime’s `live_release_revision`) or a specific stage runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectRuntimeReleaseSource {
    /// First `project_runtimes` row with [`PlatformEnvironmentType::Prod`] for this project.
    Production,
    /// The stage runtime identified by `runtime_id` (URL path).
    Stage { runtime_id: Uuid },
}

/// Which runtime row to read [`project_runtimes::live_release_revision`] from (NATS deploy handler, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveReleaseRevisionSource {
    /// First `project_runtimes` row with [`PlatformEnvironmentType::Prod`] for this project.
    Production,
    Stage { runtime_id: Uuid },
}

/// Reads `project_runtimes.live_release_revision` for prod or a stage runtime (no Redis).
pub async fn load_live_release_revision_for_runtime(
    pool: &DbPool,
    project_id: Uuid,
    source: LiveReleaseRevisionSource,
) -> Result<Option<i32>, ServiceError> {
    match source {
        LiveReleaseRevisionSource::Production => {
            let prod_runtime_id = block_on_db(pool, move |conn| {
                project_runtimes::table
                    .filter(project_runtimes::project_id.eq(project_id))
                    .filter(project_runtimes::environment.eq(PlatformEnvironmentType::Prod))
                    .order(project_runtimes::id.asc())
                    .select(project_runtimes::id)
                    .first::<Uuid>(conn)
                    .optional()
            })
            .await?;
            let Some(prod_rid) = prod_runtime_id else {
                return Ok(None);
            };
            let lr_row = block_on_db(pool, move |conn| {
                project_runtimes::table
                    .filter(project_runtimes::id.eq(prod_rid))
                    .select(project_runtimes::live_release_revision)
                    .first::<Option<i32>>(conn)
                    .optional()
            })
            .await?;
            Ok(lr_row.flatten())
        }
        LiveReleaseRevisionSource::Stage { runtime_id } => {
            let lr_row = block_on_db(pool, move |conn| {
                project_runtimes::table
                    .filter(project_runtimes::id.eq(runtime_id))
                    .filter(project_runtimes::project_id.eq(project_id))
                    .select(project_runtimes::live_release_revision)
                    .first::<Option<i32>>(conn)
                    .optional()
            })
            .await?;
            Ok(lr_row.flatten())
        }
    }
}

async fn redis_get_json<T: serde::de::DeserializeOwned>(
    redis: &SharedRedisConn,
    key: &str,
) -> Result<Option<T>, redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(None);
    };
    let mut conn = rc.lock().await;
    let s: Option<String> = conn.get(key).await?;
    let Some(raw) = s else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

async fn redis_set_json<T: Serialize>(
    redis: &SharedRedisConn,
    key: &str,
    value: &T,
) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    let raw = serde_json::to_string(value).expect("serialize release/unit cache");
    let _: () = conn.set(key, raw).await?;
    Ok(())
}

/// Loads the release row for a project using [`project_runtimes::live_release_revision`] when set, else the latest
/// release for that mode (`is_stage` false for production, true for stage).
async fn load_latest_release_for_project_runtime(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    source: ProjectRuntimeReleaseSource,
) -> Result<Option<ProjectReleaseRow>, ServiceError> {
    let cache_scope = match source {
        ProjectRuntimeReleaseSource::Production => ProjectRuntimeCacheScope::Prod,
        ProjectRuntimeReleaseSource::Stage { runtime_id } => {
            ProjectRuntimeCacheScope::Stage { runtime_id }
        }
    };
    let cache_key = redis_key_release(project_id, cache_scope);
    if let Some(cached) = redis_get_json::<ProjectReleaseRow>(redis, &cache_key).await? {
        return Ok(Some(cached));
    }

    let is_stage = matches!(source, ProjectRuntimeReleaseSource::Stage { .. });

    let live_rev: i32 = match source {
        ProjectRuntimeReleaseSource::Production => {
            let prod_runtime_id = block_on_db(pool, move |conn| {
                project_runtimes::table
                    .filter(project_runtimes::project_id.eq(project_id))
                    .filter(project_runtimes::environment.eq(PlatformEnvironmentType::Prod))
                    .order(project_runtimes::id.asc())
                    .select(project_runtimes::id)
                    .first::<Uuid>(conn)
                    .optional()
            })
            .await?;
            let Some(prod_rid) = prod_runtime_id else {
                tracing::warn!(
                    %project_id,
                    environment = ?PlatformEnvironmentType::Prod,
                    "[unit trigger] no release: project_runtimes row missing (filters: project_id, environment)"
                );
                return Ok(None);
            };
            let lr_row = block_on_db(pool, move |conn| {
                project_runtimes::table
                    .filter(project_runtimes::id.eq(prod_rid))
                    .select(project_runtimes::live_release_revision)
                    .first::<Option<i32>>(conn)
                    .optional()
            })
            .await?;
            match lr_row {
                None => {
                    tracing::warn!(
                        runtime_id = %prod_rid,
                        "[unit trigger] no release: project_runtimes row missing (filter: id = runtime_id)"
                    );
                    return Ok(None);
                }
                Some(None) => {
                    tracing::warn!(
                        runtime_id = %prod_rid,
                        "[unit trigger] no release: project_runtimes.live_release_revision is NULL (filter: id = runtime_id)"
                    );
                    return Ok(None);
                }
                Some(Some(rev)) => rev,
            }
        }
        ProjectRuntimeReleaseSource::Stage { runtime_id } => {
            let lr_row = block_on_db(pool, move |conn| {
                project_runtimes::table
                    .filter(project_runtimes::id.eq(runtime_id))
                    .filter(project_runtimes::project_id.eq(project_id))
                    .select(project_runtimes::live_release_revision)
                    .first::<Option<i32>>(conn)
                    .optional()
            })
            .await?;
            match lr_row {
                None => {
                    tracing::warn!(
                        %project_id,
                        %runtime_id,
                        "[unit trigger] no release: project_runtimes row missing (filters: project_id, id = runtime_id)"
                    );
                    return Ok(None);
                }
                Some(None) => {
                    tracing::warn!(
                        %project_id,
                        %runtime_id,
                        "[unit trigger] no release: project_runtimes.live_release_revision is NULL (filters: project_id, id = runtime_id)"
                    );
                    return Ok(None);
                }
                Some(Some(rev)) => rev,
            }
        }
    };

    let row = block_on_db(pool, move |conn| {
        project_releases::table
            .filter(project_releases::project_id.eq(project_id))
            .filter(project_releases::is_stage.eq(is_stage))
            .filter(project_releases::revision.eq(live_rev))
            .select(ProjectReleaseRow::as_select())
            .first::<ProjectReleaseRow>(conn)
            .optional()
    })
    .await?;

    let Some(out) = row else {
        tracing::warn!(
            %project_id,
            is_stage,
            revision = live_rev,
            "[unit trigger] no release: project_releases row missing (filters: project_id, is_stage, revision)"
        );
        return Ok(None);
    };
    redis_set_json(redis, &cache_key, &out).await?;
    Ok(Some(out))
}

/// Production: same as [`load_latest_release_for_project_runtime`] with [`ProjectRuntimeReleaseSource::Production`].
async fn load_latest_production_release(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
) -> Result<Option<ProjectReleaseRow>, ServiceError> {
    load_latest_release_for_project_runtime(
        pool,
        redis,
        project_id,
        ProjectRuntimeReleaseSource::Production,
    )
    .await
}

/// Stage: same as [`load_latest_release_for_project_runtime`] with [`ProjectRuntimeReleaseSource::Stage`].
async fn load_latest_stage_release_for_runtime(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    runtime_id: Uuid,
) -> Result<Option<ProjectReleaseRow>, ServiceError> {
    load_latest_release_for_project_runtime(
        pool,
        redis,
        project_id,
        ProjectRuntimeReleaseSource::Stage { runtime_id },
    )
    .await
}

/// True when `unit_path` has four segments and the third equals `unit_type.as_slug()`.
fn unit_path_matches_unit_type(unit_path: &str, unit_type: ProjectUnitType) -> bool {
    let parts: Vec<&str> = unit_path.split('.').filter(|p| !p.is_empty()).collect();
    parts.len() == 4 && parts[2] == unit_type.as_slug()
}

/// Parses a *full unit id* into `(unit_path, revision)` where `unit_path` is the four-segment logical path
/// (everything before the final numeric revision segment).
fn path_and_revision_from_full_unit_id(full_unit_id: &str) -> Option<(String, i32)> {
    let parts: Vec<&str> = full_unit_id.split('.').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let rev: i32 = parts.last()?.parse().ok()?;
    if rev < 1 {
        return None;
    }
    let unit_path = parts[..parts.len() - 1].join(".");
    Some((unit_path, rev))
}

/// Finds the *full unit id* (`unitId` in JSON) and chat session from release `units_metadata` for a logical
/// unit path (`context.module.unit_type.unit_name` — no revision segment; matches the `unit_path` argument).
///
/// Only [`crate::models::projects::UnitsMetadata::combined_unit_ids`] is consulted — the same live set used for Redis invalidation on
/// deploy ([`crate::services::project_runtime_cache::clear_project_runtime_cache_on_deploy`]). Entries that
/// appear only in `new_unit_ids` or `previous_unit_ids` are not loaded or cached so we do not store redundant
/// rows in Redis.
fn resolve_unit_from_release_metadata(
    release: &ProjectReleaseRow,
    unit_path: &str,
) -> Option<(String, Uuid)> {
    let meta = release.units_metadata.as_ref()?;
    for e in &meta.combined_unit_ids {
        if let Some((path_from_full_id, _rev)) = path_and_revision_from_full_unit_id(&e.unit_id) {
            if path_from_full_id == unit_path {
                return Some((e.unit_id.clone(), e.chat_session_id));
            }
        }
    }
    None
}

/// Loads a unit row using a logical path and an already-resolved release (avoids extra Redis/DB for the release).
async fn load_unit_for_path_with_release(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    cache_scope: ProjectRuntimeCacheScope,
    unit_type: ProjectUnitType,
    unit_path: &str,
    release: &ProjectReleaseRow,
) -> Result<Option<ProjectUnitRow>, ServiceError> {
    if !unit_path_matches_unit_type(unit_path, unit_type) {
        return Err(ServiceError::UnitPathTypeMismatch);
    }

    let Some((full_unit_id, chat_session_id)) =
        resolve_unit_from_release_metadata(release, unit_path)
    else {
        tracing::warn!(
            %project_id,
            unit_path,
            release_id = %release.id,
            release_revision = release.revision,
            "[unit trigger] unit path not in release units_metadata (no DB query; scanned metadata for release)"
        );
        return Ok(None);
    };

    let (_, revision) = path_and_revision_from_full_unit_id(&full_unit_id)
        .ok_or(ServiceError::InvalidUnitIdInMetadata)?;

    let cache_key = redis_key_unit(project_id, cache_scope, &full_unit_id);
    if let Some(cached) = redis_get_json::<ProjectUnitRow>(redis, &cache_key).await? {
        return Ok(Some(cached));
    }

    // `project_units.id` is the full dotted id (including the revision segment), not the four-segment path.
    let full_unit_id_for_db = full_unit_id.clone();
    let row = block_on_db(pool, move |conn| {
        project_units::table
            .filter(project_units::project_id.eq(project_id))
            .filter(project_units::chat_session_id.eq(chat_session_id))
            .filter(project_units::id.eq(&full_unit_id_for_db))
            .filter(project_units::revision.eq(revision))
            .select(ProjectUnitRow::as_select())
            .first::<ProjectUnitRow>(conn)
            .optional()
    })
    .await?;

    let Some(out) = row else {
        tracing::warn!(
            %project_id,
            %chat_session_id,
            full_unit_id = %full_unit_id,
            revision,
            unit_path,
            "[unit trigger] project_units row not found (query filters: project_id, chat_session_id, id, revision)"
        );
        return Ok(None);
    };
    if out.unit_type != unit_type {
        return Err(ServiceError::LoadedUnitTypeMismatch);
    }
    redis_set_json(redis, &cache_key, &out).await?;
    Ok(Some(out))
}

/// Loads latest production release, then the unit for `unit_path`.
pub async fn load_unit_for_path_production(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    unit_type: ProjectUnitType,
    unit_path: &str,
) -> Result<Option<ProjectUnitRow>, ServiceError> {
    let Some(rel) = load_latest_production_release(pool, redis, project_id).await? else {
        return Ok(None);
    };
    load_unit_for_path_with_release(
        pool,
        redis,
        project_id,
        ProjectRuntimeCacheScope::Prod,
        unit_type,
        unit_path,
        &rel,
    )
    .await
}

/// Loads stage release for runtime, then the unit for `unit_path`.
pub async fn load_unit_for_path_stage(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    runtime_id: Uuid,
    unit_type: ProjectUnitType,
    unit_path: &str,
) -> Result<Option<ProjectUnitRow>, ServiceError> {
    let Some(rel) =
        load_latest_stage_release_for_runtime(pool, redis, project_id, runtime_id).await?
    else {
        return Ok(None);
    };
    load_unit_for_path_with_release(
        pool,
        redis,
        project_id,
        ProjectRuntimeCacheScope::Stage { runtime_id },
        unit_type,
        unit_path,
        &rel,
    )
    .await
}

/// Loads a release row by project, stage flag, and revision (deploy handlers, NATS, etc.).
pub async fn load_project_release_by_revision(
    pool: &DbPool,
    project_id: Uuid,
    is_stage: bool,
    revision: i32,
) -> Result<Option<ProjectReleaseRow>, ServiceError> {
    let row = block_on_db(pool, move |conn| {
        project_releases::table
            .filter(project_releases::project_id.eq(project_id))
            .filter(project_releases::is_stage.eq(is_stage))
            .filter(project_releases::revision.eq(revision))
            .select(ProjectReleaseRow::as_select())
            .first::<ProjectReleaseRow>(conn)
            .optional()
    })
    .await?;
    Ok(row)
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Db(#[from] BlockingDbError),
    #[error(transparent)]
    Redis(#[from] redis::RedisError),
    #[error("invalid unit id in release metadata")]
    InvalidUnitIdInMetadata,
    #[error("unit path does not match requested unit type")]
    UnitPathTypeMismatch,
    #[error("loaded unit does not match requested unit type")]
    LoadedUnitTypeMismatch,
}

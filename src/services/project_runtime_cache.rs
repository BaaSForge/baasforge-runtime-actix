//! Redis cache layout for project runtime scope (prod or stage runtime) and full-scope invalidation on deploy.
//!
//! **Scope:** Keys are under `shared:units:` — one `shared:units:{project_id}:prod:` tree for the project’s
//! single production runtime (domain rule: at most one prod runtime per project), and separate
//! `shared:units:{runtime_id}:` trees per stage runtime (runtime id is globally unique; project id is not part of the key).
//! Callers must pass the correct [`ProjectRuntimeCacheScope`]; routines here never invalidate sibling runtimes
//! or the whole project.
//!
//! On deploy (production or stage — same rules, different prefix), the cached release row and **all** per-unit keys
//! for that scope are deleted. Caches refill via read-through on the next unit/release load.

use crate::database::SharedRedisConn;
use redis::AsyncCommands;
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

pub(crate) async fn redis_get_json<T: DeserializeOwned>(
    redis: &SharedRedisConn,
    key: &str,
) -> Result<Option<T>, redis::RedisError> {
    let Some(rc) = redis else {
        crate::rt_step!("redis.get_json.skip", key, reason = "no_conn");
        return Ok(None);
    };
    crate::rt_step!("redis.get_json", key);
    let mut conn = rc.lock().await;
    let s: Option<String> = conn.get(key).await?;
    let Some(raw) = s else {
        crate::rt_step!("redis.get_json.miss", key);
        return Ok(None);
    };
    crate::rt_step!("redis.get_json.hit", key);
    Ok(serde_json::from_str(&raw).ok())
}

pub(crate) async fn redis_set_json<T: Serialize>(
    redis: &SharedRedisConn,
    key: &str,
    value: &T,
) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        crate::rt_step!("redis.set_json.skip", key, reason = "no_conn");
        return Ok(());
    };
    crate::rt_step!("redis.set_json", key);
    let mut conn = rc.lock().await;
    let raw = serde_json::to_string(value).expect("serialize redis cache value");
    let _: () = conn.set(key, raw).await?;
    Ok(())
}

/// Redis cache scope: production (`shared:units:{project_id}:prod:*`) or one stage runtime (`shared:units:{runtime_id}:*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRuntimeCacheScope {
    Prod,
    Stage { runtime_id: Uuid },
}

pub(crate) fn redis_scope_prefix(project_id: Uuid, scope: ProjectRuntimeCacheScope) -> String {
    match scope {
        ProjectRuntimeCacheScope::Prod => format!("shared:units:{project_id}:prod:"),
        ProjectRuntimeCacheScope::Stage { runtime_id } => format!("shared:units:{runtime_id}:"),
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

/// Clears the cached release row and every per-unit key for one prod or stage scope.
pub async fn clear_project_runtime_cache_on_deploy(
    redis: &SharedRedisConn,
    project_id: Uuid,
    scope: ProjectRuntimeCacheScope,
) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    let scope_prefix = redis_scope_prefix(project_id, scope);

    let _: () = conn.del(redis_key_release(project_id, scope)).await?;

    let pattern = format!("{scope_prefix}unit:*");
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(&pattern)
        .query_async(&mut *conn)
        .await?;
    for key in keys {
        let _: () = conn.del(key).await?;
    }

    Ok(())
}

//! Seeds deterministic test entities when `TEST_MODE=true`.
//!
//! Inserts a fixed user, project, runtime (production), release, chat session,
//! and one `project_units` row per collected [`UnitSpec`]. All rows use
//! well-known UUIDs so they can be cleanly removed on shutdown.
//!
//! Unit-type-specific collectors live in submodules (e.g. `api_units`,
//! `workflow_units`). Each returns `Vec<UnitSpec>` that the orchestrator
//! here merges into a single release.

mod actor_units;
mod api_units;
mod queue_worker_units;
mod workflow_units;

use crate::actor_schema::{actor_alarms, actor_snapshots};
use crate::configs::Settings;
use crate::database::{DbPool, SharedRedisConn};
use crate::services::actor_engine::ACTOR_NATS_STREAM;
use crate::services::queue_worker_engine::WQ_NATS_WORK_STREAM;
use crate::services::workflow_engine::SharedRedis;
use diesel::delete;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::Text;
use redis::AsyncCommands;
use std::path::Path;
use uuid::Uuid;

pub(crate) const TEST_USER_ID: &str = "00000000-aaaa-bbbb-cccc-000000000001";
pub(crate) const TEST_PROJECT_ID: &str = "00000000-aaaa-bbbb-cccc-000000000010";
pub(crate) const TEST_RUNTIME_ID: &str = "00000000-aaaa-bbbb-cccc-000000000020";
pub(crate) const TEST_RELEASE_ID: &str = "00000000-aaaa-bbbb-cccc-000000000030";
pub(crate) const TEST_CHAT_SESSION_ID: &str = "00000000-aaaa-bbbb-cccc-000000000040";

pub(crate) const TEST_ALT_PROJECT_ID: &str = "00000000-aaaa-bbbb-cccc-000000000012";
pub(crate) const TEST_ALT_RUNTIME_ID: &str = "00000000-aaaa-bbbb-cccc-000000000021";
pub(crate) const TEST_ALT_RELEASE_ID: &str = "00000000-aaaa-bbbb-cccc-000000000031";
pub(crate) const TEST_ALT_CHAT_SESSION_ID: &str = "00000000-aaaa-bbbb-cccc-000000000041";

pub(crate) const TEST_STAGE_RUNTIME_ID: &str = "00000000-aaaa-bbbb-cccc-000000000022";
pub(crate) const TEST_STAGE_RELEASE_ID: &str = "00000000-aaaa-bbbb-cccc-000000000032";
pub(crate) const TEST_STAGE_CHAT_SESSION_ID: &str = "00000000-aaaa-bbbb-cccc-000000000042";
pub(crate) const TEST_STAGE_B_RUNTIME_ID: &str = "00000000-aaaa-bbbb-cccc-000000000023";
pub(crate) const TEST_STAGE_B_RELEASE_ID: &str = "00000000-aaaa-bbbb-cccc-000000000033";
pub(crate) const TEST_STAGE_B_CHAT_SESSION_ID: &str = "00000000-aaaa-bbbb-cccc-000000000043";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RuntimeTarget {
    All,
    StageAOnly,
    StageBOnly,
}

#[derive(Clone)]
pub(crate) struct UnitSpec {
    pub context_slug: String,
    pub module_slug: String,
    pub unit_name_slug: String,
    pub unit_type: String,
    pub full_id: String,
    pub compiled_code: String,
    pub(super) runtime_target: RuntimeTarget,
}

pub(super) fn discover_unit_js_files(dir: &Path, sorted: bool) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return results;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    if sorted {
        entries.sort_by_key(|e| e.file_name());
    }
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            for (rel, code) in discover_unit_js_files(&path, sorted) {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                results.push((format!("{dir_name}/{rel}"), code));
            }
        } else if path.extension().is_some_and(|e| e == "js") {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "index.js" {
                continue;
            }
            if let Ok(code) = std::fs::read_to_string(&path) {
                results.push((name, code));
            }
        }
    }
    results
}

pub(crate) fn unit_path_from_full_id(full_id: &str) -> String {
    let parts: Vec<&str> = full_id.split('.').collect();
    parts[..parts.len() - 1].join(".")
}

fn merge_stage_overrides(base_units: &[UnitSpec], stage_overrides: Vec<UnitSpec>) -> Vec<UnitSpec> {
    let mut merged: Vec<UnitSpec> = base_units.to_vec();
    for override_spec in stage_overrides {
        if let Some(idx) = merged
            .iter()
            .position(|u| u.full_id == override_spec.full_id)
        {
            merged[idx] = override_spec;
        } else {
            merged.push(override_spec);
        }
    }
    merged
}

pub(super) fn stem_without_runtime_suffix(stem: &str) -> (String, RuntimeTarget) {
    if let Some(base) = stem.strip_suffix("-runtime-stage-a") {
        return (base.to_string(), RuntimeTarget::StageAOnly);
    }
    if let Some(base) = stem.strip_suffix("-runtime-stage-b") {
        return (base.to_string(), RuntimeTarget::StageBOnly);
    }
    (stem.to_string(), RuntimeTarget::All)
}

// ---------------------------------------------------------------------------
// Public API (called from routes/mod.rs)
// ---------------------------------------------------------------------------

pub fn seed_test_entities(pool: &DbPool, settings: &Settings) {
    let mut conn = pool.get().expect("test_seed: cannot get DB connection");

    let mut discovered_units: Vec<UnitSpec> = Vec::new();
    discovered_units.extend(api_units::collect(settings));
    discovered_units.extend(workflow_units::collect(settings));
    discovered_units.extend(queue_worker_units::collect(settings));
    discovered_units.extend(actor_units::collect());

    let mut all_units: Vec<UnitSpec> = Vec::new();
    let mut stage_a_overrides: Vec<UnitSpec> = Vec::new();
    let mut stage_b_overrides: Vec<UnitSpec> = Vec::new();
    for spec in discovered_units {
        match spec.runtime_target {
            RuntimeTarget::All => all_units.push(spec),
            RuntimeTarget::StageAOnly => stage_a_overrides.push(spec),
            RuntimeTarget::StageBOnly => stage_b_overrides.push(spec),
        }
    }
    let stage_a_units = merge_stage_overrides(&all_units, stage_a_overrides);
    let stage_b_units = merge_stage_overrides(&all_units, stage_b_overrides);

    tracing::info!("test_seed: seeding {} test unit(s)", all_units.len());

    for pid in [TEST_PROJECT_ID, TEST_ALT_PROJECT_ID] {
        sql_query("DELETE FROM project_units WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM project_runtimes WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM project_releases WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM chat_sessions WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM projects WHERE id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
    }
    sql_query("DELETE FROM users WHERE id = $1::uuid")
        .bind::<Text, _>(TEST_USER_ID)
        .execute(&mut conn)
        .ok();

    sql_query(
        "INSERT INTO users (id, platform, id_in_platform, full_name, email_in_platform) \
         VALUES ($1::uuid, 'google', 'test-seed-user', 'Test Seed User', 'test@seed.local') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert user");

    sql_query(
        "INSERT INTO projects (id, owner_user_id, name, slug) \
         VALUES ($1::uuid, $2::uuid, 'Test Project', 'test-project') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert project");

    sql_query(
        "INSERT INTO projects (id, owner_user_id, name, slug) \
         VALUES ($1::uuid, $2::uuid, 'Test Alt Project', 'test-alt-project') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_ALT_PROJECT_ID)
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert alt project");

    sql_query(
        "INSERT INTO chat_sessions (id, project_id, user_id, title, created_at) \
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'test-session', NOW()) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_CHAT_SESSION_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert chat_session");

    sql_query(
        "INSERT INTO chat_sessions (id, project_id, user_id, title, created_at) \
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'test-alt-session', NOW()) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_ALT_CHAT_SESSION_ID)
    .bind::<Text, _>(TEST_ALT_PROJECT_ID)
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert alt chat_session");

    sql_query(
        "INSERT INTO chat_sessions (id, project_id, user_id, title, created_at) \
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'test-stage-session', NOW()) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_STAGE_CHAT_SESSION_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert stage chat_session");
    sql_query(
        "INSERT INTO chat_sessions (id, project_id, user_id, title, created_at) \
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'test-stage-b-session', NOW()) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind::<Text, _>(TEST_STAGE_B_CHAT_SESSION_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_USER_ID)
    .execute(&mut conn)
    .expect("test_seed: insert stage-b chat_session");

    let mut combined_unit_ids: Vec<serde_json::Value> = Vec::new();
    let mut alt_combined_unit_ids: Vec<serde_json::Value> = Vec::new();
    let mut stage_a_combined_unit_ids: Vec<serde_json::Value> = Vec::new();
    let mut stage_b_combined_unit_ids: Vec<serde_json::Value> = Vec::new();

    for spec in &all_units {
        combined_unit_ids.push(serde_json::json!({
            "unitId": spec.full_id,
            "chatSessionId": TEST_CHAT_SESSION_ID,
        }));
        alt_combined_unit_ids.push(serde_json::json!({
            "unitId": spec.full_id,
            "chatSessionId": TEST_ALT_CHAT_SESSION_ID,
        }));

        sql_query(
            "INSERT INTO project_units \
             (project_id, chat_session_id, id, revision, unit_type, \
              context_slug, module_slug, unit_name_slug, \
              compiled_code, code, is_deleted) \
             VALUES ($1::uuid, $2::uuid, $3, 1, $4::project_unit_type, \
                     $5, $6, $7, $8, $9, false) \
             ON CONFLICT (project_id, chat_session_id, id, revision) DO UPDATE \
             SET compiled_code = EXCLUDED.compiled_code, code = EXCLUDED.code",
        )
        .bind::<Text, _>(TEST_PROJECT_ID)
        .bind::<Text, _>(TEST_CHAT_SESSION_ID)
        .bind::<Text, _>(&spec.full_id)
        .bind::<Text, _>(&spec.unit_type)
        .bind::<Text, _>(&spec.context_slug)
        .bind::<Text, _>(&spec.module_slug)
        .bind::<Text, _>(&spec.unit_name_slug)
        .bind::<Text, _>(&spec.compiled_code)
        .bind::<Text, _>(&spec.compiled_code)
        .execute(&mut conn)
        .unwrap_or_else(|e| panic!("test_seed: insert unit '{}': {e}", spec.full_id));

        sql_query(
            "INSERT INTO project_units \
             (project_id, chat_session_id, id, revision, unit_type, \
              context_slug, module_slug, unit_name_slug, \
              compiled_code, code, is_deleted) \
             VALUES ($1::uuid, $2::uuid, $3, 1, $4::project_unit_type, \
                     $5, $6, $7, $8, $9, false) \
             ON CONFLICT (project_id, chat_session_id, id, revision) DO UPDATE \
             SET compiled_code = EXCLUDED.compiled_code, code = EXCLUDED.code",
        )
        .bind::<Text, _>(TEST_ALT_PROJECT_ID)
        .bind::<Text, _>(TEST_ALT_CHAT_SESSION_ID)
        .bind::<Text, _>(&spec.full_id)
        .bind::<Text, _>(&spec.unit_type)
        .bind::<Text, _>(&spec.context_slug)
        .bind::<Text, _>(&spec.module_slug)
        .bind::<Text, _>(&spec.unit_name_slug)
        .bind::<Text, _>(&spec.compiled_code)
        .bind::<Text, _>(&spec.compiled_code)
        .execute(&mut conn)
        .unwrap_or_else(|e| panic!("test_seed: insert alt unit '{}': {e}", spec.full_id));
    }
    for spec in &stage_a_units {
        stage_a_combined_unit_ids.push(serde_json::json!({
            "unitId": spec.full_id,
            "chatSessionId": TEST_STAGE_CHAT_SESSION_ID,
        }));
        sql_query(
            "INSERT INTO project_units \
             (project_id, chat_session_id, id, revision, unit_type, \
              context_slug, module_slug, unit_name_slug, \
              compiled_code, code, is_deleted) \
             VALUES ($1::uuid, $2::uuid, $3, 1, $4::project_unit_type, \
                     $5, $6, $7, $8, $9, false) \
             ON CONFLICT (project_id, chat_session_id, id, revision) DO UPDATE \
             SET compiled_code = EXCLUDED.compiled_code, code = EXCLUDED.code",
        )
        .bind::<Text, _>(TEST_PROJECT_ID)
        .bind::<Text, _>(TEST_STAGE_CHAT_SESSION_ID)
        .bind::<Text, _>(&spec.full_id)
        .bind::<Text, _>(&spec.unit_type)
        .bind::<Text, _>(&spec.context_slug)
        .bind::<Text, _>(&spec.module_slug)
        .bind::<Text, _>(&spec.unit_name_slug)
        .bind::<Text, _>(&spec.compiled_code)
        .bind::<Text, _>(&spec.compiled_code)
        .execute(&mut conn)
        .unwrap_or_else(|e| panic!("test_seed: insert stage unit '{}': {e}", spec.full_id));
    }
    for spec in &stage_b_units {
        stage_b_combined_unit_ids.push(serde_json::json!({
            "unitId": spec.full_id,
            "chatSessionId": TEST_STAGE_B_CHAT_SESSION_ID,
        }));
        sql_query(
            "INSERT INTO project_units \
             (project_id, chat_session_id, id, revision, unit_type, \
              context_slug, module_slug, unit_name_slug, \
              compiled_code, code, is_deleted) \
             VALUES ($1::uuid, $2::uuid, $3, 1, $4::project_unit_type, \
                     $5, $6, $7, $8, $9, false) \
             ON CONFLICT (project_id, chat_session_id, id, revision) DO UPDATE \
             SET compiled_code = EXCLUDED.compiled_code, code = EXCLUDED.code",
        )
        .bind::<Text, _>(TEST_PROJECT_ID)
        .bind::<Text, _>(TEST_STAGE_B_CHAT_SESSION_ID)
        .bind::<Text, _>(&spec.full_id)
        .bind::<Text, _>(&spec.unit_type)
        .bind::<Text, _>(&spec.context_slug)
        .bind::<Text, _>(&spec.module_slug)
        .bind::<Text, _>(&spec.unit_name_slug)
        .bind::<Text, _>(&spec.compiled_code)
        .bind::<Text, _>(&spec.compiled_code)
        .execute(&mut conn)
        .unwrap_or_else(|e| panic!("test_seed: insert stage-b unit '{}': {e}", spec.full_id));
    }

    let units_metadata = serde_json::json!({
        "combinedUnitIDs": combined_unit_ids,
        "newUnitIDs": combined_unit_ids,
        "previousUnitIDs": [],
    });
    let alt_units_metadata = serde_json::json!({
        "combinedUnitIDs": alt_combined_unit_ids,
        "newUnitIDs": alt_combined_unit_ids,
        "previousUnitIDs": [],
    });
    let stage_a_units_metadata = serde_json::json!({
        "combinedUnitIDs": stage_a_combined_unit_ids,
        "newUnitIDs": stage_a_combined_unit_ids,
        "previousUnitIDs": [],
    });
    let stage_b_units_metadata = serde_json::json!({
        "combinedUnitIDs": stage_b_combined_unit_ids,
        "newUnitIDs": stage_b_combined_unit_ids,
        "previousUnitIDs": [],
    });

    sql_query(
        "INSERT INTO project_releases (id, project_id, units_metadata, created_at, is_stage, revision) \
         VALUES ($1::uuid, $2::uuid, $3::jsonb, NOW(), false, 1.0) \
         ON CONFLICT (id) DO UPDATE SET units_metadata = EXCLUDED.units_metadata",
    )
    .bind::<Text, _>(TEST_RELEASE_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(units_metadata.to_string())
    .execute(&mut conn)
    .expect("test_seed: insert release");

    sql_query(
        "INSERT INTO project_releases (id, project_id, units_metadata, created_at, is_stage, revision) \
         VALUES ($1::uuid, $2::uuid, $3::jsonb, NOW(), false, 1.0) \
         ON CONFLICT (id) DO UPDATE SET units_metadata = EXCLUDED.units_metadata",
    )
    .bind::<Text, _>(TEST_ALT_RELEASE_ID)
    .bind::<Text, _>(TEST_ALT_PROJECT_ID)
    .bind::<Text, _>(alt_units_metadata.to_string())
    .execute(&mut conn)
    .expect("test_seed: insert alt release");

    sql_query(
        "INSERT INTO project_runtimes (id, project_id, environment, name, slug, live_release_id) \
         VALUES ($1::uuid, $2::uuid, 'prod'::platform_environment_type, 'production', 'production', $3::uuid) \
         ON CONFLICT (id) DO UPDATE SET live_release_id = EXCLUDED.live_release_id",
    )
    .bind::<Text, _>(TEST_RUNTIME_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_RELEASE_ID)
    .execute(&mut conn)
    .expect("test_seed: insert runtime");

    sql_query(
        "INSERT INTO project_runtimes (id, project_id, environment, name, slug, live_release_id) \
         VALUES ($1::uuid, $2::uuid, 'prod'::platform_environment_type, 'production', 'production', $3::uuid) \
         ON CONFLICT (id) DO UPDATE SET live_release_id = EXCLUDED.live_release_id",
    )
    .bind::<Text, _>(TEST_ALT_RUNTIME_ID)
    .bind::<Text, _>(TEST_ALT_PROJECT_ID)
    .bind::<Text, _>(TEST_ALT_RELEASE_ID)
    .execute(&mut conn)
    .expect("test_seed: insert alt runtime");

    sql_query(
        "INSERT INTO project_releases (id, project_id, units_metadata, created_at, is_stage, revision) \
         VALUES ($1::uuid, $2::uuid, $3::jsonb, NOW(), true, 1.0) \
         ON CONFLICT (id) DO UPDATE SET units_metadata = EXCLUDED.units_metadata",
    )
    .bind::<Text, _>(TEST_STAGE_RELEASE_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(stage_a_units_metadata.to_string())
    .execute(&mut conn)
    .expect("test_seed: insert stage release");
    sql_query(
        "INSERT INTO project_releases (id, project_id, units_metadata, created_at, is_stage, revision) \
         VALUES ($1::uuid, $2::uuid, $3::jsonb, NOW(), true, 1.0) \
         ON CONFLICT (id) DO UPDATE SET units_metadata = EXCLUDED.units_metadata",
    )
    .bind::<Text, _>(TEST_STAGE_B_RELEASE_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(stage_b_units_metadata.to_string())
    .execute(&mut conn)
    .expect("test_seed: insert stage-b release");

    sql_query(
        "INSERT INTO project_runtimes (id, project_id, environment, name, slug, live_release_id) \
         VALUES ($1::uuid, $2::uuid, 'prod'::platform_environment_type, 'stage', 'stage', $3::uuid) \
         ON CONFLICT (id) DO UPDATE SET live_release_id = EXCLUDED.live_release_id",
    )
    .bind::<Text, _>(TEST_STAGE_RUNTIME_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_STAGE_RELEASE_ID)
    .execute(&mut conn)
    .expect("test_seed: insert stage runtime");
    sql_query(
        "INSERT INTO project_runtimes (id, project_id, environment, name, slug, live_release_id) \
         VALUES ($1::uuid, $2::uuid, 'prod'::platform_environment_type, 'stage-b', 'stage-b', $3::uuid) \
         ON CONFLICT (id) DO UPDATE SET live_release_id = EXCLUDED.live_release_id",
    )
    .bind::<Text, _>(TEST_STAGE_B_RUNTIME_ID)
    .bind::<Text, _>(TEST_PROJECT_ID)
    .bind::<Text, _>(TEST_STAGE_B_RELEASE_ID)
    .execute(&mut conn)
    .expect("test_seed: insert stage-b runtime");

    for spec in &all_units {
        let path = unit_path_from_full_id(&spec.full_id);
        tracing::info!(
            unit_path = %path,
            full_id = %spec.full_id,
            unit_type = %spec.unit_type,
            "test_seed: registered unit"
        );
    }

    tracing::info!(
        project_id = TEST_PROJECT_ID,
        runtime_id = TEST_RUNTIME_ID,
        release_id = TEST_RELEASE_ID,
        "test_seed: all test entities seeded"
    );
}

pub fn teardown_test_entities(pool: &DbPool) {
    let Ok(mut conn) = pool.get() else {
        tracing::warn!("test_seed: cannot get DB connection for teardown");
        return;
    };

    tracing::info!("test_seed: tearing down test entities");

    for pid in [TEST_PROJECT_ID, TEST_ALT_PROJECT_ID] {
        sql_query("DELETE FROM project_units WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM project_runtimes WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM project_releases WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM chat_sessions WHERE project_id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
        sql_query("DELETE FROM projects WHERE id = $1::uuid")
            .bind::<Text, _>(pid)
            .execute(&mut conn)
            .ok();
    }
    sql_query("DELETE FROM users WHERE id = $1::uuid")
        .bind::<Text, _>(TEST_USER_ID)
        .execute(&mut conn)
        .ok();
}

pub async fn clear_test_project_runtime_redis_cache(redis: &SharedRedisConn) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    for prefix in [
        format!("{TEST_PROJECT_ID}:prod:"),
        format!("{TEST_ALT_PROJECT_ID}:prod:"),
        format!("{TEST_STAGE_RUNTIME_ID}:"),
        format!("{TEST_STAGE_B_RUNTIME_ID}:"),
    ] {
        let pattern = format!("{prefix}*");
        let keys: Vec<String> = redis::cmd("KEYS").arg(&pattern).query_async(&mut *conn).await?;
        for key in keys {
            let _: () = conn.del(key).await?;
        }
    }
    Ok(())
}

pub async fn clear_test_workflow_redis(wf: &Option<SharedRedis>) -> Result<(), redis::RedisError> {
    let Some(rc) = wf else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    for pid in [TEST_PROJECT_ID, TEST_ALT_PROJECT_ID] {
        let pattern = format!("wf:{pid}:*");
        let keys: Vec<String> = redis::cmd("KEYS").arg(&pattern).query_async(&mut *conn).await?;
        for key in keys {
            let _: () = conn.del(key).await?;
        }
    }
    Ok(())
}

pub async fn clear_test_queue_worker_redis(wq: &Option<SharedRedis>) -> Result<(), redis::RedisError> {
    let Some(rc) = wq else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    for pid in [TEST_PROJECT_ID, TEST_ALT_PROJECT_ID] {
        let pattern = format!("wq:{pid}:*");
        let keys: Vec<String> = redis::cmd("KEYS").arg(&pattern).query_async(&mut *conn).await?;
        for key in keys {
            let _: () = conn.del(key).await?;
        }
    }
    Ok(())
}

fn test_mode_alarm_zset_member_is_seeded(m: &str) -> bool {
    let parts: Vec<&str> = m.split('\t').collect();
    match parts.as_slice() {
        ["prod", pid, _, _, _] => *pid == TEST_PROJECT_ID || *pid == TEST_ALT_PROJECT_ID,
        ["stage", rid, pid, _, _, _] => {
            *rid == TEST_STAGE_RUNTIME_ID
                || *rid == TEST_STAGE_B_RUNTIME_ID
                || *pid == TEST_PROJECT_ID
                || *pid == TEST_ALT_PROJECT_ID
        }
        _ => false,
    }
}

pub async fn clear_test_actor_redis(actor: &Option<SharedRedis>) -> Result<(), redis::RedisError> {
    let Some(rc) = actor else {
        return Ok(());
    };
    let mut conn = rc.lock().await;
    for prefix in [
        format!("actor:p:{TEST_PROJECT_ID}:"),
        format!("actor:p:{TEST_ALT_PROJECT_ID}:"),
        format!("actor:s:{TEST_STAGE_RUNTIME_ID}:"),
        format!("actor:s:{TEST_STAGE_B_RUNTIME_ID}:"),
    ] {
        let pattern = format!("{prefix}*");
        let keys: Vec<String> = redis::cmd("KEYS").arg(&pattern).query_async(&mut *conn).await?;
        for key in keys {
            let _: () = conn.del(key).await?;
        }
    }
    let global_key = "actor:alarms:global";
    let members: Vec<String> = redis::cmd("ZRANGE")
        .arg(global_key)
        .arg(0isize)
        .arg(-1isize)
        .query_async(&mut *conn)
        .await
        .unwrap_or_default();
    for m in members {
        if test_mode_alarm_zset_member_is_seeded(&m) {
            let _: () = redis::cmd("ZREM")
                .arg(global_key)
                .arg(&m)
                .query_async(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

pub fn teardown_actor_test_pg(settings: &Settings) {
    let Some(ref url) = settings.actor_database_url else {
        return;
    };
    let pool = crate::models::actor_store::build_actor_pg_pool(
        url,
        1,
        settings.actor_database_connection_timeout_secs.max(1),
    );
    let Ok(mut conn) = pool.get() else {
        tracing::warn!("test_seed: cannot get actor DB connection for teardown");
        return;
    };
    for pid in [TEST_PROJECT_ID, TEST_ALT_PROJECT_ID] {
        let Ok(u) = Uuid::parse_str(pid) else {
            continue;
        };
        let _ = delete(actor_snapshots::table.filter(actor_snapshots::project_id.eq(u))).execute(&mut conn);
        let _ = delete(actor_alarms::table.filter(actor_alarms::project_id.eq(u))).execute(&mut conn);
    }
}

pub struct TestModeTeardown {
    pub pool: DbPool,
    pub settings: Settings,
    pub redis_conn: SharedRedisConn,
    pub wf_redis: Option<SharedRedis>,
    pub wq_redis: Option<SharedRedis>,
    pub actor_redis: Option<SharedRedis>,
    pub wf_jetstream: Option<async_nats::jetstream::Context>,
    pub wq_jetstream: Option<async_nats::jetstream::Context>,
    pub actor_jetstream: Option<async_nats::jetstream::Context>,
}

impl TestModeTeardown {
    pub async fn run(self) {
        teardown_test_mode_persistence(
            &self.pool,
            &self.settings,
            &self.redis_conn,
            &self.wf_redis,
            &self.wq_redis,
            &self.actor_redis,
            &self.wf_jetstream,
            &self.wq_jetstream,
            &self.actor_jetstream,
        )
        .await;
    }
}

async fn purge_jetstream_subject_prefix(
    js: &Option<async_nats::jetstream::Context>,
    stream_name: &str,
    subject_filter: &str,
) {
    let Some(js) = js else {
        return;
    };
    let Ok(stream) = js.get_stream(stream_name).await else {
        return;
    };
    if let Err(e) = stream.purge().filter(subject_filter.to_string()).await {
        tracing::warn!(
            error = %e,
            stream = %stream_name,
            filter = %subject_filter,
            "test_seed: JetStream purge failed"
        );
    }
}

pub async fn teardown_test_mode_persistence(
    pool: &DbPool,
    settings: &Settings,
    redis_conn: &SharedRedisConn,
    wf_redis: &Option<SharedRedis>,
    wq_redis: &Option<SharedRedis>,
    actor_redis: &Option<SharedRedis>,
    wf_jetstream: &Option<async_nats::jetstream::Context>,
    wq_jetstream: &Option<async_nats::jetstream::Context>,
    actor_jetstream: &Option<async_nats::jetstream::Context>,
) {
    tracing::info!("test_seed: test-mode persistence teardown (Redis, JetStream, PG)");

    let wf_stream = settings
        .wf_nats_jetstream_stream
        .as_deref()
        .unwrap_or("WF_WAKE");
    let actor_stream = settings
        .actor_nats_jetstream_stream
        .as_deref()
        .unwrap_or(ACTOR_NATS_STREAM);

    for pid in [TEST_PROJECT_ID, TEST_ALT_PROJECT_ID] {
        let wf_filter = format!("wf.{pid}.>");
        purge_jetstream_subject_prefix(wf_jetstream, wf_stream, &wf_filter).await;
        let wq_filter = format!("wq.{pid}.>");
        purge_jetstream_subject_prefix(wq_jetstream, WQ_NATS_WORK_STREAM, &wq_filter).await;
        let actor_filter = format!("actor.{pid}.>");
        purge_jetstream_subject_prefix(actor_jetstream, actor_stream, &actor_filter).await;
    }

    if let Err(e) = clear_test_actor_redis(actor_redis).await {
        tracing::warn!(error = %e, "test_seed: actor Redis teardown failed");
    }
    if let Err(e) = clear_test_workflow_redis(wf_redis).await {
        tracing::warn!(error = %e, "test_seed: workflow Redis teardown failed");
    }
    if let Err(e) = clear_test_queue_worker_redis(wq_redis).await {
        tracing::warn!(error = %e, "test_seed: queue-worker Redis teardown failed");
    }
    if let Err(e) = clear_test_project_runtime_redis_cache(redis_conn).await {
        tracing::warn!(
            error = %e,
            "test_seed: project-runtime Redis cache teardown failed"
        );
    }

    teardown_actor_test_pg(settings);
    teardown_test_entities(pool);
}

pub fn print_trigger_urls(settings: &Settings) {
    let port = &settings.port;
    let base_api = format!("http://127.0.0.1:{port}/api/v1/trigger/{TEST_PROJECT_ID}");
    let base_wf = format!("http://127.0.0.1:{port}/api/v1/trigger/wf/{TEST_PROJECT_ID}");

    for tuf in &settings.test_unit_files {
        let spec = api_units::spec_for_label(&tuf.label, String::new());
        let path = unit_path_from_full_id(&spec.full_id);
        let parts: Vec<&str> = path.split('.').collect();
        if parts.len() == 4 {
            let url = format!("{base_api}/{}/{}/{}", parts[0], parts[1], parts[3]);
            eprintln!("  TEST_TRIGGER [{label}]: {url}", label = tuf.label);
        }
    }

    if settings.test_workflow_dir.is_some() {
        eprintln!("  WORKFLOW_BASE: {base_wf}/test/wf/{{workflow_name}}");
    }
}

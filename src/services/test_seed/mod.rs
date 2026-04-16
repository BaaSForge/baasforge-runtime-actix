//! Seeds deterministic test entities when `TEST_MODE=true`.
//!
//! Inserts a fixed user, project, runtime (production), release, chat session,
//! and one `project_units` row per collected [`UnitSpec`]. All rows use
//! well-known UUIDs so they can be cleanly removed on shutdown.
//!
//! Unit-type-specific collectors live in submodules (e.g. `api_units`,
//! `workflow_units`). Each returns `Vec<UnitSpec>` that the orchestrator
//! here merges into a single release.

mod api_units;
mod queue_worker_units;
mod workflow_units;

use crate::configs::Settings;
use crate::database::DbPool;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::Text;

pub(crate) const TEST_USER_ID: &str = "00000000-aaaa-bbbb-cccc-000000000001";
pub(crate) const TEST_PROJECT_ID: &str = "00000000-aaaa-bbbb-cccc-000000000010";
pub(crate) const TEST_RUNTIME_ID: &str = "00000000-aaaa-bbbb-cccc-000000000020";
pub(crate) const TEST_RELEASE_ID: &str = "00000000-aaaa-bbbb-cccc-000000000030";
pub(crate) const TEST_CHAT_SESSION_ID: &str = "00000000-aaaa-bbbb-cccc-000000000040";

pub(crate) const TEST_ALT_PROJECT_ID: &str = "00000000-aaaa-bbbb-cccc-000000000012";
pub(crate) const TEST_ALT_RUNTIME_ID: &str = "00000000-aaaa-bbbb-cccc-000000000021";
pub(crate) const TEST_ALT_RELEASE_ID: &str = "00000000-aaaa-bbbb-cccc-000000000031";
pub(crate) const TEST_ALT_CHAT_SESSION_ID: &str = "00000000-aaaa-bbbb-cccc-000000000041";

pub(crate) struct UnitSpec {
    pub context_slug: String,
    pub module_slug: String,
    pub unit_name_slug: String,
    pub unit_type: String,
    pub full_id: String,
    pub compiled_code: String,
}

pub(crate) fn unit_path_from_full_id(full_id: &str) -> String {
    let parts: Vec<&str> = full_id.split('.').collect();
    parts[..parts.len() - 1].join(".")
}

// ---------------------------------------------------------------------------
// Public API (called from routes/mod.rs)
// ---------------------------------------------------------------------------

pub fn seed_test_entities(pool: &DbPool, settings: &Settings) {
    let mut conn = pool.get().expect("test_seed: cannot get DB connection");

    let mut all_units: Vec<UnitSpec> = Vec::new();
    all_units.extend(api_units::collect(settings));
    all_units.extend(workflow_units::collect(settings));
    all_units.extend(queue_worker_units::collect(settings));

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

    let mut combined_unit_ids: Vec<serde_json::Value> = Vec::new();
    let mut alt_combined_unit_ids: Vec<serde_json::Value> = Vec::new();

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

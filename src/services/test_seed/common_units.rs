//! Collects common-module units from `TEST_COMMON_DIR`.
//!
//! - `lib/**` → `unit_type: common` (injected shared code, no trigger)
//! - other `**/*.js` (except companions) → `unit_type: api` harness endpoints

use super::UnitSpec;
use crate::libs::unit_slug::normalize_filename_stem_to_slug;
use serde_json::json;
use std::path::Path;

const SKIP_API_DISCOVERY_PREFIXES: &[&str] = &[
    "companion-actors/",
    "companion-workflows/",
    "companion-queue-workers/",
];

fn is_common_lib_path(rel_path: &str) -> bool {
    rel_path.starts_with("lib/") || rel_path.contains("/lib/")
}

fn should_skip_api_discovery(rel_path: &str) -> bool {
    if is_common_lib_path(rel_path) {
        return true;
    }
    if rel_path.starts_with("packages/") {
        return true;
    }
    SKIP_API_DISCOVERY_PREFIXES
        .iter()
        .any(|p| rel_path.starts_with(p))
}

fn api_unit_seed_metadata(unit_name_slug: &str, rel_path: &str) -> Option<serde_json::Value> {
    if unit_name_slug == "index" {
        return Some(json!({ "method": "GET", "timeout_seconds": 120 }));
    }
    if rel_path.starts_with("sdk-chain/")
        || rel_path.starts_with("cross-unit/")
    {
        return Some(json!({ "method": "POST" }));
    }
    Some(json!({ "method": "GET" }))
}

fn spec_from_common_lib_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let (base_stem, runtime_target) = super::stem_without_runtime_suffix(stem);
    let unit_name_slug = normalize_filename_stem_to_slug(&base_stem)?;
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "common".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "common".into(),
        full_id: format!("test.common.common.{unit_name_slug}.1"),
        compiled_code,
        seed_source: format!("TEST_COMMON_DIR/{rel_path}"),
        runtime_target,
        metadata: None,
    })
}

fn spec_from_api_harness_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let (base_stem, runtime_target) = super::stem_without_runtime_suffix(stem);
    let unit_name_slug = normalize_filename_stem_to_slug(&base_stem)?;
    let metadata = api_unit_seed_metadata(&unit_name_slug, rel_path);
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "common".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "api".into(),
        full_id: format!("test.common.api.{unit_name_slug}.1"),
        compiled_code,
        seed_source: format!("TEST_COMMON_DIR/{rel_path}"),
        runtime_target,
        metadata,
    })
}

pub(super) fn collect() -> Vec<UnitSpec> {
    let Ok(dir_str) = std::env::var("TEST_COMMON_DIR") else {
        return Vec::new();
    };
    let dir_str = dir_str.trim().to_string();
    if dir_str.is_empty() {
        return Vec::new();
    }

    let dir = Path::new(&dir_str);
    if !dir.is_dir() {
        tracing::warn!("test_seed: TEST_COMMON_DIR={dir_str} is not a directory");
        return Vec::new();
    }

    let files = super::discover_unit_js_files(dir, true);
    tracing::info!(
        "test_seed: discovered {} common-module JS files in {dir_str}",
        files.len(),
    );

    let mut out = Vec::new();
    for (rel_path, code) in files {
        if is_common_lib_path(&rel_path) {
            match spec_from_common_lib_path(&rel_path, code) {
                Some(spec) => out.push(spec),
                None => tracing::warn!(
                    rel_path = %rel_path,
                    "test_seed: skip common lib file (cannot map filename stem to valid unit_name_slug)"
                ),
            }
            continue;
        }
        if should_skip_api_discovery(&rel_path) {
            continue;
        }
        match spec_from_api_harness_path(&rel_path, code) {
            Some(spec) => out.push(spec),
            None => tracing::warn!(
                rel_path = %rel_path,
                "test_seed: skip common harness file (cannot map filename stem to valid unit_name_slug)"
            ),
        }
    }
    out
}

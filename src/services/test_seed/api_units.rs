//! Collects API-type [`UnitSpec`]s from `TEST_UNIT_FILES` and `TEST_API_DIR`.

use super::{RuntimeTarget, UnitSpec};
use crate::configs::Settings;
use crate::libs::unit_slug::normalize_filename_stem_to_slug;
use serde_json::json;
use std::path::Path;

fn api_unit_seed_metadata(module_slug: &str, unit_name_slug: &str) -> Option<serde_json::Value> {
    if unit_name_slug == "custom-short-timeout" {
        return Some(json!({ "method": "GET", "timeout_seconds": 2 }));
    }
    if unit_name_slug == "timeout-seconds-zero" {
        return Some(json!({ "method": "GET", "timeout_seconds": 0 }));
    }
    if unit_name_slug == "timeout-seconds-null" {
        return Some(json!({ "method": "GET", "timeout_seconds": null }));
    }
    if unit_name_slug == "timeout-seconds-invalid-type" {
        return Some(json!({ "method": "GET", "timeout_seconds": "5" }));
    }
    if unit_name_slug == "long-cap-echo" {
        return Some(json!({ "method": "GET", "timeout_seconds": 120 }));
    }
    if unit_name_slug == "post-method" {
        return Some(json!({ "method": "POST" }));
    }
    if unit_name_slug == "text-body-echo" {
        return Some(json!({ "method": "POST" }));
    }
    if module_slug == "api-tests" && unit_name_slug == "index" {
        return Some(json!({ "method": "GET", "timeout_seconds": 120 }));
    }
    Some(json!({ "method": "GET" }))
}

fn spec_from_api_dir_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let (base_stem, runtime_target) = super::stem_without_runtime_suffix(stem);
    let unit_name_slug = normalize_filename_stem_to_slug(&base_stem)?;
    let metadata = api_unit_seed_metadata("api-tests", &unit_name_slug);
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "api-tests".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "api".into(),
        full_id: format!("test.api-tests.api.{unit_name_slug}.1"),
        compiled_code,
        seed_source: format!("TEST_API_DIR/{rel_path}"),
        runtime_target,
        metadata,
    })
}

pub(super) fn spec_for_label(label: &str, seed_source: String, compiled_code: String) -> UnitSpec {
    let metadata = if compiled_code.is_empty() {
        None
    } else {
        match label {
            "runtime-check" => api_unit_seed_metadata("runtime", "check"),
            "runtime-check-qs" => api_unit_seed_metadata("runtime", "qs"),
            "runtime-check-cookie" => api_unit_seed_metadata("runtime", "cookie"),
            "runtime-check-statuses" => api_unit_seed_metadata("runtime", "statuses"),
            "runtime-check-multipart-parser" => api_unit_seed_metadata("runtime", "multipart-parser"),
            "runtime-check-mime-types" => api_unit_seed_metadata("runtime", "mime-types"),
            "runtime-check-http-errors" => api_unit_seed_metadata("runtime", "http-errors"),
            "runtime-check-zod" => api_unit_seed_metadata("runtime", "zod"),
            "runtime-check-validator" => api_unit_seed_metadata("runtime", "validator"),
            "workflow-tests" => api_unit_seed_metadata("wf", "test"),
            "queue-worker-tests" => api_unit_seed_metadata("queue-worker-tests", "index"),
            "actor-tests" => api_unit_seed_metadata("actor-tests", "index"),
            "api-tests" => api_unit_seed_metadata("api-tests", "index"),
            "common" => api_unit_seed_metadata("common", "index"),
            other => {
                let m = other.replace('-', "_");
                api_unit_seed_metadata(&m, &m)
            }
        }
    };
    match label {
        "runtime-check" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "check".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.check.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
        "runtime-check-qs" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "qs".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.qs.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-cookie" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "cookie".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.cookie.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-statuses" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "statuses".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.statuses.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-multipart-parser" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "multipart-parser".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.multipart-parser.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-mime-types" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "mime-types".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.mime-types.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-http-errors" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "http-errors".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.http-errors.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-zod" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "zod".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.zod.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-validator" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "validator".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.validator.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "workflow-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "wf".into(),
            unit_name_slug: "test".into(),
            unit_type: "api".into(),
            full_id: "test.wf.api.test.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
        "queue-worker-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "queue-worker-tests".into(),
            unit_name_slug: "index".into(),
            unit_type: "api".into(),
            full_id: "test.queue-worker-tests.api.index.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
        "actor-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "actor-tests".into(),
            unit_name_slug: "index".into(),
            unit_type: "api".into(),
            full_id: "test.actor-tests.api.index.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
        "api-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "api-tests".into(),
            unit_name_slug: "index".into(),
            unit_type: "api".into(),
            full_id: "test.api-tests.api.index.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
        "common" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "common".into(),
            unit_name_slug: "index".into(),
            unit_type: "api".into(),
            full_id: "test.common.api.index.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
        other => UnitSpec {
            context_slug: "test".into(),
            module_slug: other.replace('-', "_").to_string(),
            unit_name_slug: other.replace('-', "_").to_string(),
            unit_type: "api".into(),
            full_id: format!("test.{m}.api.{m}.1", m = other.replace('-', "_")),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata,
        },
    }
}

pub(super) fn collect(settings: &Settings) -> Vec<UnitSpec> {
    let mut out = Vec::new();

    for tuf in &settings.test_unit_files {
        let code = match std::fs::read_to_string(&tuf.path) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(path = %tuf.path, error = %e, "test_seed: cannot read unit file");
                continue;
            }
        };
        let seed_source = format!("TEST_UNIT_FILES label={} path={}", tuf.label, tuf.path);
        out.push(spec_for_label(&tuf.label, seed_source, code));
    }

    if let Ok(dir_str) = std::env::var("TEST_API_DIR") {
        let dir_str = dir_str.trim().to_string();
        if !dir_str.is_empty() {
            let dir = Path::new(&dir_str);
            if !dir.is_dir() {
                tracing::warn!("test_seed: TEST_API_DIR={dir_str} is not a directory");
            } else {
                let files = super::discover_unit_js_files(dir, true);
                tracing::info!(
                    "test_seed: discovered {} API JS files in {dir_str}",
                    files.len(),
                );
                for (rel_path, code) in files {
                    match spec_from_api_dir_path(&rel_path, code) {
                        Some(spec) => out.push(spec),
                        None => tracing::warn!(
                            rel_path = %rel_path,
                            "test_seed: skip API file (cannot map filename stem to valid unit_name_slug)"
                        ),
                    }
                }
            }
        }
    }

    out
}

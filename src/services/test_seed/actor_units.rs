use super::UnitSpec;
use crate::libs::unit_slug::normalize_filename_stem_to_slug;
use std::path::Path;

fn unit_type_for_stem(stem: &str) -> &'static str {
    match stem {
        "call-actor-from-api" => "api",
        "call-actor-from-workflow" | "call-actor-from-queue-worker" | "echo-target" => "queue_worker",
        "double-n"
        | "call-actor-durable-basic"
        | "call-actor-durable-unknown-handler"
        | "runtime-scope-actor-caller" => "workflow",
        _ => "actor",
    }
}

fn spec_from_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let (base_stem, runtime_target) = super::stem_without_runtime_suffix(stem);
    let unit_name_slug = normalize_filename_stem_to_slug(&base_stem)?;
    let unit_type = unit_type_for_stem(&base_stem);
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "actor-tests".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: unit_type.into(),
        full_id: format!("test.actor-tests.{unit_type}.{unit_name_slug}.1"),
        compiled_code,
        runtime_target,
    })
}

pub(super) fn collect() -> Vec<UnitSpec> {
    let dir_str = match std::env::var("TEST_ACTOR_DIR") {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return Vec::new(),
    };

    let dir = Path::new(&dir_str);
    if !dir.is_dir() {
        tracing::warn!("test_seed: TEST_ACTOR_DIR={dir_str} is not a directory");
        return Vec::new();
    }

    let files = super::discover_unit_js_files(dir, true);
    tracing::info!(
        "test_seed: discovered {} actor JS files in {dir_str}",
        files.len(),
    );

    let mut out = Vec::new();
    for (rel_path, code) in files {
        match spec_from_path(&rel_path, code) {
            Some(spec) => out.push(spec),
            None => tracing::warn!(
                rel_path = %rel_path,
                "test_seed: skip actor file (cannot map filename stem to valid unit_name_slug)"
            ),
        }
    }
    out
}

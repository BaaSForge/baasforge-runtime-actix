use super::UnitSpec;
use crate::configs::Settings;
use crate::libs::unit_slug::normalize_filename_stem_to_slug;
use std::path::Path;

fn spec_from_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let (base_stem, runtime_target) = super::stem_without_runtime_suffix(stem);
    let unit_name_slug = normalize_filename_stem_to_slug(&base_stem)?;
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "queue-worker".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "queue_worker".into(),
        full_id: format!("test.queue-worker.queue_worker.{unit_name_slug}.1"),
        compiled_code,
        seed_source: format!("TEST_QUEUE_WORKER_DIR/{rel_path}"),
        runtime_target,
        metadata: None,
    })
}

pub(super) fn collect(settings: &Settings) -> Vec<UnitSpec> {
    let Some(ref qw_dir) = settings.test_queue_worker_dir else {
        return Vec::new();
    };

    let dir = Path::new(qw_dir);
    if !dir.is_dir() {
        tracing::warn!("test_seed: TEST_QUEUE_WORKER_DIR={qw_dir} is not a directory");
        return Vec::new();
    }

    let files = super::discover_unit_js_files(dir, true);
    tracing::info!(
        "test_seed: discovered {} queue worker JS files in {}",
        files.len(),
        qw_dir
    );

    let mut out = Vec::new();
    for (rel_path, code) in files {
        if rel_path.starts_with("seed/workflows/") || rel_path.starts_with("seed/actors/") {
            continue;
        }
        match spec_from_path(&rel_path, code) {
            Some(spec) => out.push(spec),
            None => tracing::warn!(
                rel_path = %rel_path,
                "test_seed: skip queue worker file (cannot map filename stem to valid unit_name_slug)"
            ),
        }
    }
    out
}

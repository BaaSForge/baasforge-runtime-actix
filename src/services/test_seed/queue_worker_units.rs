use super::UnitSpec;
use crate::configs::Settings;
use crate::libs::unit_slug::normalize_filename_stem_to_slug;
use std::path::Path;

fn queue_worker_spec_from_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let unit_name_slug = normalize_filename_stem_to_slug(stem)?;
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "queue-worker".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "queue_worker".into(),
        full_id: format!("test.queue-worker.queue_worker.{unit_name_slug}.1"),
        compiled_code,
    })
}

fn discover_queue_worker_js_files(dir: &Path) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return results;
    };
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());
    for entry in sorted {
        let path = entry.path();
        if path.is_dir() {
            for (rel, code) in discover_queue_worker_js_files(&path) {
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

pub(super) fn collect(settings: &Settings) -> Vec<UnitSpec> {
    let Some(ref qw_dir) = settings.test_queue_worker_dir else {
        return Vec::new();
    };

    let dir = Path::new(qw_dir);
    if !dir.is_dir() {
        tracing::warn!("test_seed: TEST_QUEUE_WORKER_DIR={qw_dir} is not a directory");
        return Vec::new();
    }

    let files = discover_queue_worker_js_files(dir);
    tracing::info!(
        "test_seed: discovered {} queue worker JS files in {}",
        files.len(),
        qw_dir
    );

    let mut out = Vec::new();
    for (rel_path, code) in files {
        match queue_worker_spec_from_path(&rel_path, code) {
            Some(spec) => out.push(spec),
            None => tracing::warn!(
                rel_path = %rel_path,
                "test_seed: skip queue worker file (cannot map filename stem to valid unit_name_slug)"
            ),
        }
    }
    out
}

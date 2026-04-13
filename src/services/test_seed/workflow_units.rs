//! Collects workflow-type [`UnitSpec`]s by scanning `TEST_WORKFLOW_DIR`.

use super::UnitSpec;
use crate::configs::Settings;
use crate::libs::unit_slug::normalize_filename_stem_to_slug;
use std::path::Path;

fn spec_from_path(rel_path: &str, compiled_code: String) -> Option<UnitSpec> {
    let stem = Path::new(rel_path).file_stem()?.to_str()?;
    let unit_name_slug = normalize_filename_stem_to_slug(stem)?;
    Some(UnitSpec {
        context_slug: "test".into(),
        module_slug: "wf".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "workflow".into(),
        full_id: format!("test.wf.workflow.{unit_name_slug}.1"),
        compiled_code,
    })
}

fn discover_js_files(dir: &Path) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return results;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            for (rel, code) in discover_js_files(&path) {
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
    let Some(ref wf_dir) = settings.test_workflow_dir else {
        return Vec::new();
    };

    let dir = Path::new(wf_dir);
    if !dir.is_dir() {
        tracing::warn!("test_seed: TEST_WORKFLOW_DIR={wf_dir} is not a directory");
        return Vec::new();
    }

    let files = discover_js_files(dir);
    tracing::info!(
        "test_seed: discovered {} workflow JS files in {}",
        files.len(),
        wf_dir
    );

    let mut out = Vec::new();
    for (rel_path, code) in files {
        if let Some(spec) = spec_from_path(&rel_path, code) {
            out.push(spec);
        } else if let Some(stem) = Path::new(&rel_path).file_stem().and_then(|s| s.to_str()) {
            tracing::warn!(
                rel_path = %rel_path,
                stem = %stem,
                "test_seed: skip workflow file (cannot map filename stem to a valid unit_name_slug)"
            );
        }
    }
    out
}

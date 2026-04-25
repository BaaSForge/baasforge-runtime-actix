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
        module_slug: "wf".into(),
        unit_name_slug: unit_name_slug.clone(),
        unit_type: "workflow".into(),
        full_id: format!("test.wf.workflow.{unit_name_slug}.1"),
        compiled_code,
        runtime_target,
    })
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

    let files = super::discover_unit_js_files(dir, false);
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

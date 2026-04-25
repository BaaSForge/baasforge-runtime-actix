//! Collects API-type [`UnitSpec`]s from `TEST_UNIT_FILES`.

use super::{RuntimeTarget, UnitSpec};
use crate::configs::Settings;

pub(super) fn spec_for_label(label: &str, compiled_code: String) -> UnitSpec {
    match label {
        "runtime-check" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "check".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.check.1".into(),
            compiled_code,
            runtime_target: RuntimeTarget::All,
        },
        "workflow-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "wf".into(),
            unit_name_slug: "test".into(),
            unit_type: "api".into(),
            full_id: "test.wf.api.test.1".into(),
            compiled_code,
            runtime_target: RuntimeTarget::All,
        },
        "queue-worker-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "queue-worker-tests".into(),
            unit_name_slug: "index".into(),
            unit_type: "api".into(),
            full_id: "test.queue-worker-tests.api.index.1".into(),
            compiled_code,
            runtime_target: RuntimeTarget::All,
        },
        "actor-tests" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "actor-tests".into(),
            unit_name_slug: "index".into(),
            unit_type: "api".into(),
            full_id: "test.actor-tests.api.index.1".into(),
            compiled_code,
            runtime_target: RuntimeTarget::All,
        },
        other => UnitSpec {
            context_slug: "test".into(),
            module_slug: other.replace('-', "_").to_string(),
            unit_name_slug: other.replace('-', "_").to_string(),
            unit_type: "api".into(),
            full_id: format!("test.{m}.api.{m}.1", m = other.replace('-', "_")),
            compiled_code,
            runtime_target: RuntimeTarget::All,
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
        out.push(spec_for_label(&tuf.label, code));
    }
    out
}

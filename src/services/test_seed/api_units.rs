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
            "runtime-check-jose" => api_unit_seed_metadata("runtime", "jose"),
            "runtime-check-bcryptjs" => api_unit_seed_metadata("runtime", "bcryptjs"),
            "runtime-check-otplib" => api_unit_seed_metadata("runtime", "otplib"),
            "runtime-check-statuses" => api_unit_seed_metadata("runtime", "statuses"),
            "runtime-check-multipart-parser" => api_unit_seed_metadata("runtime", "multipart-parser"),
            "runtime-check-mime-types" => api_unit_seed_metadata("runtime", "mime-types"),
            "runtime-check-http-errors" => api_unit_seed_metadata("runtime", "http-errors"),
            "runtime-check-zod" => api_unit_seed_metadata("runtime", "zod"),
            "runtime-check-validator" => api_unit_seed_metadata("runtime", "validator"),
            "runtime-check-change-case" => api_unit_seed_metadata("runtime", "change-case"),
            "runtime-check-slugify" => api_unit_seed_metadata("runtime", "slugify"),
            "runtime-check-pluralize" => api_unit_seed_metadata("runtime", "pluralize"),
            "runtime-check-escape-html" => api_unit_seed_metadata("runtime", "escape-html"),
            "runtime-check-xss" => api_unit_seed_metadata("runtime", "xss"),
            "runtime-check-lodash-es" => api_unit_seed_metadata("runtime", "lodash-es"),
            "runtime-check-nanoid" => api_unit_seed_metadata("runtime", "nanoid"),
            "runtime-check-uuid" => api_unit_seed_metadata("runtime", "uuid"),
            "runtime-check-semver" => api_unit_seed_metadata("runtime", "semver"),
            "runtime-check-ms" => api_unit_seed_metadata("runtime", "ms"),
            "runtime-check-p-retry" => api_unit_seed_metadata("runtime", "p-retry"),
            "runtime-check-p-timeout" => api_unit_seed_metadata("runtime", "p-timeout"),
            "runtime-check-p-limit" => api_unit_seed_metadata("runtime", "p-limit"),
            "runtime-check-dayjs" => api_unit_seed_metadata("runtime", "dayjs"),
            "runtime-check-luxon" => api_unit_seed_metadata("runtime", "luxon"),
            "runtime-check-cron-parser" => api_unit_seed_metadata("runtime", "cron-parser"),
            "runtime-check-decimal.js" => api_unit_seed_metadata("runtime", "decimal-js"),
            "runtime-check-big.js" => api_unit_seed_metadata("runtime", "big-js"),
            "runtime-check-dinero.js" => api_unit_seed_metadata("runtime", "dinero-js"),
            "runtime-check-js-yaml" => api_unit_seed_metadata("runtime", "js-yaml"),
            "runtime-check-papaparse" => api_unit_seed_metadata("runtime", "papaparse"),
            "runtime-check-fast-xml-parser" => api_unit_seed_metadata("runtime", "fast-xml-parser"),
            "runtime-check-superjson" => api_unit_seed_metadata("runtime", "superjson"),
            "runtime-check-fflate" => api_unit_seed_metadata("runtime", "fflate"),
            "runtime-check-mustache" => api_unit_seed_metadata("runtime", "mustache"),
            "runtime-check-handlebars" => api_unit_seed_metadata("runtime", "handlebars"),
            "runtime-check-marked" => api_unit_seed_metadata("runtime", "marked"),
            "runtime-check-node-html-parser" => {
                api_unit_seed_metadata("runtime", "node-html-parser")
            }
            "runtime-check-diff" => api_unit_seed_metadata("runtime", "diff"),
            "runtime-check-fuse.js" => api_unit_seed_metadata("runtime", "fuse-js"),
            "runtime-check-minisearch" => api_unit_seed_metadata("runtime", "minisearch"),
            "runtime-check-pdf-lib" => api_unit_seed_metadata("runtime", "pdf-lib"),
            "runtime-check-qrcode" => api_unit_seed_metadata("runtime", "qrcode"),
            "runtime-check-oauth4webapi" => api_unit_seed_metadata("runtime", "oauth-four-webapi"),
            "runtime-check-arctic" => api_unit_seed_metadata("runtime", "arctic"),
            "runtime-check-standardwebhooks" => {
                api_unit_seed_metadata("runtime", "standardwebhooks")
            }
            "runtime-check-libphonenumber-js" => {
                api_unit_seed_metadata("runtime", "libphonenumber-js")
            }
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
        "runtime-check-jose" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "jose".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.jose.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-bcryptjs" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "bcryptjs".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.bcryptjs.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-otplib" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "otplib".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.otplib.1".into(),
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
        "runtime-check-change-case" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "change-case".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.change-case.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-slugify" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "slugify".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.slugify.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-pluralize" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "pluralize".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.pluralize.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-escape-html" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "escape-html".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.escape-html.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-xss" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "xss".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.xss.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-lodash-es" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "lodash-es".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.lodash-es.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-nanoid" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "nanoid".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.nanoid.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-uuid" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "uuid".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.uuid.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-semver" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "semver".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.semver.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-ms" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "ms".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.ms.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-p-retry" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "p-retry".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.p-retry.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-p-timeout" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "p-timeout".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.p-timeout.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-p-limit" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "p-limit".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.p-limit.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-dayjs" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "dayjs".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.dayjs.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-luxon" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "luxon".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.luxon.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-cron-parser" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "cron-parser".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.cron-parser.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-decimal.js" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "decimal-js".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.decimal-js.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-big.js" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "big-js".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.big-js.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-dinero.js" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "dinero-js".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.dinero-js.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-js-yaml" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "js-yaml".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.js-yaml.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-papaparse" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "papaparse".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.papaparse.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-fast-xml-parser" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "fast-xml-parser".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.fast-xml-parser.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-superjson" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "superjson".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.superjson.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-fflate" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "fflate".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.fflate.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-mustache" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "mustache".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.mustache.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-handlebars" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "handlebars".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.handlebars.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-marked" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "marked".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.marked.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-node-html-parser" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "node-html-parser".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.node-html-parser.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-diff" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "diff".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.diff.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-fuse.js" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "fuse-js".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.fuse-js.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-minisearch" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "minisearch".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.minisearch.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-pdf-lib" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "pdf-lib".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.pdf-lib.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-qrcode" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "qrcode".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.qrcode.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-oauth4webapi" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "oauth-four-webapi".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.oauth-four-webapi.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-arctic" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "arctic".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.arctic.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-standardwebhooks" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "standardwebhooks".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.standardwebhooks.1".into(),
            compiled_code,
            seed_source,
            runtime_target: RuntimeTarget::All,
            metadata: Some(json!({ "method": "GET", "timeout_seconds": 120 })),
        },
        "runtime-check-libphonenumber-js" => UnitSpec {
            context_slug: "test".into(),
            module_slug: "runtime".into(),
            unit_name_slug: "libphonenumber-js".into(),
            unit_type: "api".into(),
            full_id: "test.runtime.api.libphonenumber-js.1".into(),
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

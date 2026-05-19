//! QuickJS ES module resolver/loader for user units, `@units/*` common modules, `@sdk`, and `node:*`.

use crate::database::{DbPool, SharedRedisConn};
use crate::libs::unit_slug::parse_unit_path;
use crate::models::projects::ProjectUnitType;
use crate::services::project_release::load_unit_for_path_scoped;
use rquickjs::loader::{Loader, Resolver};
use rquickjs::{Ctx, Error, Module, Object, Promise};
use rquickjs::Result as JsResult;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::sync::LazyLock;
use uuid::Uuid;

use super::common_imports::{PrepareError, UNNAMED_IMPORT_MSG, WRONG_IMPORT_MSG};
use super::module_shims::{self as shims, SDK};
use super::modules::sdk::get_comm_ctx;

pub const ENTRY_MODULE: &str = "baal-unit-entry";

static IMPORT_FROM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?m)^\s*import\s+(?P<clause>[\s\S]*?)\s*from\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#,
    )
    .expect("IMPORT_FROM_RE")
});

static IMPORT_SIDE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#).expect("IMPORT_SIDE_RE")
});

static DEFAULT_UNITS_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+\w+\s+from\s+['"]@units/"#).expect("DEFAULT_UNITS_IMPORT_RE")
});

static UNNAMED_STAR_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+\*\s+from\s+['"]"#).expect("UNNAMED_STAR_IMPORT_RE")
});

static UNNAMED_BARE_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+from\s+['"]"#).expect("UNNAMED_BARE_IMPORT_RE")
});

struct BaalModulesState {
    entry_source: String,
    common_cache: HashMap<String, String>,
    loading: HashSet<String>,
}

#[derive(Clone)]
pub struct BaalModules {
    state: Arc<Mutex<BaalModulesState>>,
}

impl BaalModules {
    pub fn new(entry_source: impl Into<String>) -> Self {
        Self {
            state: Arc::new(Mutex::new(BaalModulesState {
                entry_source: entry_source.into(),
                common_cache: HashMap::new(),
                loading: HashSet::new(),
            })),
        }
    }

    pub fn install(self, rt: &rquickjs::Runtime) {
        let resolver = self.clone();
        let loader = self;
        rt.set_loader(resolver, loader);
    }

    fn with_state<R>(&self, f: impl FnOnce(&mut BaalModulesState) -> R) -> R {
        let mut guard = self.state.lock().expect("baal module loader lock");
        f(&mut guard)
    }

    fn load_common_source(&self, unit_path: &str) -> std::result::Result<String, PrepareError> {
        if let Some(cached) = self.with_state(|state| state.common_cache.get(unit_path).cloned()) {
            return Ok(cached);
        }
        if !self.with_state(|state| state.loading.insert(unit_path.to_string())) {
            return Err(PrepareError::Load(format!(
                "circular common import: {unit_path}"
            )));
        }

        let result = (|| {
            if !is_common_path(unit_path) {
                return Err(PrepareError::WrongImport);
            }
            let comm = get_comm_ctx().ok_or_else(|| {
                PrepareError::Load("module loader: SdkCommCtx not set".to_string())
            })?;
            let project_id = Uuid::parse_str(&comm.project_id).map_err(|e| {
                PrepareError::Load(format!("invalid project_id: {e}"))
            })?;
            let source = load_common_unit_blocking(
                &comm.pool,
                &comm.redis_conn,
                project_id,
                comm.stage_runtime_id,
                unit_path,
            )?;
            validate_import_policy(&source)?;
            Ok(source)
        })();

        self.with_state(|state| {
            state.loading.remove(unit_path);
            if let Ok(ref src) = result {
                state.common_cache.insert(unit_path.to_string(), src.clone());
            }
        });

        result
    }

    fn declare_module<'js>(&self, ctx: &Ctx<'js>, name: &str, source: &str) -> JsResult<Module<'js>> {
        Module::declare(ctx.clone(), name, source.as_bytes())
    }
}

fn units_specifier(module: &str) -> Option<&str> {
    module.strip_prefix("@units/")
}

fn is_common_path(unit_path: &str) -> bool {
    parse_unit_path(unit_path)
        .ok()
        .is_some_and(|p| p.unit_type == "common")
}

/// Static import-policy checks that must run before module compilation.
pub fn validate_import_policy(source: &str) -> std::result::Result<(), PrepareError> {
    if DEFAULT_UNITS_IMPORT_RE.is_match(source) {
        return Err(PrepareError::WrongImport);
    }
    if UNNAMED_STAR_IMPORT_RE.is_match(source) || UNNAMED_BARE_IMPORT_RE.is_match(source) {
        return Err(PrepareError::UnnamedImport);
    }
    for line in source.lines() {
        if let Some(caps) = IMPORT_SIDE_RE.captures(line) {
            if units_specifier(&caps["mod"]).is_some() {
                return Err(PrepareError::WrongImport);
            }
        }
        if let Some(caps) = IMPORT_FROM_RE.captures(line) {
            let module = caps["mod"].to_string();
            let clause = caps["clause"].trim();
            if let Some(unit_path) = units_specifier(&module) {
                if !is_common_path(unit_path) {
                    return Err(PrepareError::WrongImport);
                }
                if clause == "*" || clause.is_empty() {
                    return Err(PrepareError::UnnamedImport);
                }
                let default_re = Regex::new(r"^(\w+)$").expect("default import");
                if default_re.is_match(clause) {
                    return Err(PrepareError::WrongImport);
                }
            }
        }
    }
    Ok(())
}

impl Resolver for BaalModules {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str) -> JsResult<String> {
        if name.starts_with('.') {
            let base_dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            let joined = if base_dir.is_empty() {
                name.to_string()
            } else {
                format!("{base_dir}/{name}")
            };
            return Ok(joined);
        }
        Ok(name.to_string())
    }
}

impl Loader for BaalModules {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> JsResult<Module<'js>> {
        if name == ENTRY_MODULE {
            let source = self.with_state(|s| s.entry_source.clone());
            return self.declare_module(ctx, name, &source);
        }
        if name == "@sdk" {
            return self.declare_module(ctx, name, SDK);
        }
        if let Some(src) = shims::node_module_source(name) {
            return self.declare_module(ctx, name, src);
        }
        if let Some(unit_path) = units_specifier(name) {
            let source = self.load_common_source(unit_path).map_err(|e| match e {
                PrepareError::WrongImport => Error::new_loading_message(name, WRONG_IMPORT_MSG),
                PrepareError::UnnamedImport => {
                    Error::new_loading_message(name, UNNAMED_IMPORT_MSG)
                }
                PrepareError::Load(msg) => Error::new_loading_message(name, &msg),
            })?;
            return self.declare_module(ctx, name, &source);
        }
        Err(Error::new_loading_message(
            name,
            &format!("unknown or disallowed module: {name}"),
        ))
    }
}

fn load_common_unit_blocking(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
) -> std::result::Result<String, PrepareError> {
    let unit_path_owned = unit_path.to_string();
    let unit_path_for_err = unit_path_owned.clone();
    let pool = pool.clone();
    let redis = redis.clone();
    let row = tokio::runtime::Handle::current()
        .block_on(async move {
            load_unit_for_path_scoped(
                &pool,
                &redis,
                project_id,
                stage_runtime_id,
                ProjectUnitType::Common,
                &unit_path_owned,
            )
            .await
        })
        .map_err(|e| PrepareError::Load(e.to_string()))?
        .ok_or_else(|| {
            PrepareError::Load(format!("common unit not found: {unit_path_for_err}"))
        })?;

    row.compiled_code
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| PrepareError::Load(format!("common unit has no code: {unit_path_for_err}")))
}

/// Evaluates the user entry module; call after [`BaalModules::install`] and runtime globals are registered.
pub fn import_entry_module<'js>(ctx: &Ctx<'js>) -> JsResult<Object<'js>> {
    let promise: Promise = Module::import(ctx, ENTRY_MODULE)?;
    promise.finish()
}

pub fn install_user_module_loader(
    rt: &rquickjs::Runtime,
    source: &str,
) -> std::result::Result<(), PrepareError> {
    validate_import_policy(source)?;
    BaalModules::new(source).install(rt);
    Ok(())
}

pub fn prepare_error_message(err: PrepareError) -> &'static str {
    match err {
        PrepareError::WrongImport => WRONG_IMPORT_MSG,
        PrepareError::UnnamedImport => UNNAMED_IMPORT_MSG,
        PrepareError::Load(_) => "failed to resolve common imports",
    }
}

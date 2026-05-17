//! Resolves `@units/...` value imports from **common** units into scoped IIFEs for QuickJS.
//!
//! - Executing units (api, actor, workflow, queue_worker) may value-import common units only.
//! - Type-only imports from non-common units are erased by TypeScript before runtime.
//! - Default imports from `@units/...` and value imports from non-common units → [`WrongImport`].
//! - `import * from` / `import from` on common units (no binding name) → [`UnnamedImport`].

use crate::database::{DbPool, SharedRedisConn};
use crate::libs::unit_slug::parse_unit_path;
use crate::models::projects::ProjectUnitType;
use crate::services::project_release::load_unit_for_path_scoped;
use async_recursion::async_recursion;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use uuid::Uuid;

pub const WRONG_IMPORT_MSG: &str = "wrong import";
pub const UNNAMED_IMPORT_MSG: &str = "unnamed imports from common units are not allowed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrongImport;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnnamedImport;

#[derive(Debug)]
pub enum PrepareError {
    WrongImport,
    UnnamedImport,
    Load(String),
}

impl From<WrongImport> for PrepareError {
    fn from(_: WrongImport) -> Self {
        Self::WrongImport
    }
}

impl From<UnnamedImport> for PrepareError {
    fn from(_: UnnamedImport) -> Self {
        Self::UnnamedImport
    }
}

#[derive(Clone)]
pub struct ImportResolveCtx {
    pub pool: DbPool,
    pub redis: SharedRedisConn,
    pub project_id: Uuid,
    pub stage_runtime_id: Option<Uuid>,
}

static IMPORT_FROM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?m)^\s*import\s+(?P<clause>[\s\S]*?)\s*from\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#,
    )
    .expect("IMPORT_FROM_RE")
});

static IMPORT_SIDE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#).expect("IMPORT_SIDE_RE")
});

static EXPORT_STAR_FROM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*export\s+\*\s+from\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#)
        .expect("EXPORT_STAR_FROM_RE")
});

static EXPORT_STAR_AS_FROM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^\s*export\s+\*\s+as\s+(?P<ns>\w+)\s+from\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#,
    )
    .expect("EXPORT_STAR_AS_FROM_RE")
});

static EXPORT_NAMED_FROM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*export\s+\{(?P<names>[^}]+)\}\s+from\s+['"](?P<mod>[^'"]+)['"]\s*;?\s*$"#)
        .expect("EXPORT_NAMED_FROM_RE")
});

static EXPORT_NAMED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*export\s+\{(?P<names>[^}]+)\}\s*;?\s*$").expect("EXPORT_NAMED_RE")
});

static EXPORT_DECL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*export\s+(?P<rest>.+)$").expect("EXPORT_DECL_RE")
});

fn units_specifier(module: &str) -> Option<&str> {
    module.strip_prefix("@units/")
}

fn is_common_path(unit_path: &str) -> bool {
    parse_unit_path(unit_path)
        .ok()
        .is_some_and(|p| p.unit_type == "common")
}

fn mod_var_name(unit_path: &str) -> String {
    let safe: String = unit_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    format!("__baal_common_{safe}")
}

fn collect_units_deps(source: &str) -> Vec<String> {
    let mut deps = HashSet::new();
    for line in source.lines() {
        if let Some(caps) = IMPORT_FROM_RE.captures(line) {
            if let Some(path) = units_specifier(&caps["mod"]) {
                deps.insert(path.to_string());
            }
        }
        for re in [
            &EXPORT_STAR_FROM_RE,
            &EXPORT_STAR_AS_FROM_RE,
            &EXPORT_NAMED_FROM_RE,
        ] {
            if let Some(caps) = re.captures(line) {
                if let Some(path) = units_specifier(&caps["mod"]) {
                    deps.insert(path.to_string());
                }
            }
        }
    }
    deps.into_iter().collect()
}

fn rewrite_sdk_import_line(clause: &str) -> Result<String, PrepareError> {
    let clause_trimmed = clause.trim();
    let named_re = Regex::new(r"^\{([\s\S]*)\}$").expect("named import");
    if let Some(caps) = named_re.captures(clause_trimmed) {
        let bindings = parse_named_list(caps[1].trim());
        if bindings.is_empty() {
            return Err(WrongImport.into());
        }
        let lines: Vec<String> = bindings
            .iter()
            .map(|(imported, local)| format!("const {local} = globalThis.{imported};"))
            .collect();
        return Ok(lines.join("\n"));
    }
    let default_re = Regex::new(r"^(\w+)$").expect("default import");
    if default_re.is_match(clause_trimmed) {
        return Ok(format!("const {clause_trimmed} = globalThis.{clause_trimmed};"));
    }
    Err(WrongImport.into())
}

fn parse_named_list(list: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for part in list.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (imported, local) = if let Some((a, b)) = part.split_once(" as ") {
            (a.trim().to_string(), b.trim().to_string())
        } else {
            (part.to_string(), part.to_string())
        };
        if !imported.is_empty() && !local.is_empty() {
            out.push((imported, local));
        }
    }
    out
}

struct ImportResolver<'a> {
    ctx: &'a ImportResolveCtx,
    module_iife: HashMap<String, String>,
    visiting: HashSet<String>,
}

impl<'a> ImportResolver<'a> {
    async fn prepare_executing_source(&mut self, source: &str) -> Result<String, PrepareError> {
        let mut out_lines: Vec<String> = Vec::new();
        let mut declared_modules: HashSet<String> = HashSet::new();
        for line in source.lines() {
            if let Some(caps) = IMPORT_FROM_RE.captures(line) {
                let module = caps["mod"].to_string();
                let clause = caps["clause"].trim();
                if let Some(unit_path) = units_specifier(&module) {
                    let replacement = self
                        .rewrite_units_import_line(unit_path, clause, &mut declared_modules)
                        .await?;
                    for sub in replacement.lines() {
                        out_lines.push(sub.to_string());
                    }
                    continue;
                }
                if module == "@sdk" {
                    let replacement = rewrite_sdk_import_line(clause)?;
                    for sub in replacement.lines() {
                        out_lines.push(sub.to_string());
                    }
                    continue;
                }
            } else if let Some(caps) = IMPORT_SIDE_RE.captures(line) {
                if units_specifier(&caps["mod"]).is_some() {
                    return Err(WrongImport.into());
                }
            }
            out_lines.push(line.to_string());
        }
        Ok(out_lines.join("\n"))
    }

    async fn rewrite_units_import_line(
        &mut self,
        unit_path: &str,
        clause: &str,
        declared_modules: &mut HashSet<String>,
    ) -> Result<String, PrepareError> {
        if !is_common_path(unit_path) {
            return Err(WrongImport.into());
        }

        let clause_trimmed = clause.trim();
        if clause_trimmed == "*" || clause_trimmed.is_empty() {
            return Err(UnnamedImport.into());
        }

        let default_re = Regex::new(r"^(\w+)$").expect("default import");
        let ns_re = Regex::new(r"^\*\s+as\s+(\w+)$").expect("ns import");
        let named_re = Regex::new(r"^\{([\s\S]*)\}$").expect("named import");

        if default_re.is_match(clause_trimmed) {
            return Err(WrongImport.into());
        }

        self.ensure_module_iife(unit_path).await?;
        let iife = self.module_iife[unit_path].clone();
        let mod_var = mod_var_name(unit_path);

        if let Some(caps) = ns_re.captures(clause_trimmed) {
            let local = caps[1].to_string();
            return Ok(format!("const {local} = {iife};"));
        }

        if let Some(caps) = named_re.captures(clause_trimmed) {
            let bindings = parse_named_list(caps[1].trim());
            if bindings.is_empty() {
                return Err(WrongImport.into());
            }
            let mut parts: Vec<String> = Vec::new();
            for (imported, local) in &bindings {
                if imported != local {
                    parts.push(format!("{imported}: {local}"));
                } else {
                    parts.push(imported.clone());
                }
            }
            let mut lines: Vec<String> = Vec::new();
            if declared_modules.insert(unit_path.to_string()) {
                lines.push(format!("const {mod_var} = {iife};"));
            }
            lines.push(format!("const {{ {} }} = {mod_var};", parts.join(", ")));
            return Ok(lines.join("\n"));
        }

        Err(WrongImport.into())
    }

    fn rewrite_units_import_line_sync(
        &self,
        unit_path: &str,
        clause: &str,
        declared_modules: &mut HashSet<String>,
    ) -> Result<String, PrepareError> {
        if !is_common_path(unit_path) {
            return Err(WrongImport.into());
        }
        let clause_trimmed = clause.trim();
        if clause_trimmed == "*" || clause_trimmed.is_empty() {
            return Err(UnnamedImport.into());
        }
        let default_re = Regex::new(r"^(\w+)$").expect("default import");
        let ns_re = Regex::new(r"^\*\s+as\s+(\w+)$").expect("ns import");
        let named_re = Regex::new(r"^\{([\s\S]*)\}$").expect("named import");
        if default_re.is_match(clause_trimmed) {
            return Err(WrongImport.into());
        }
        let iife = self
            .module_iife
            .get(unit_path)
            .cloned()
            .ok_or_else(|| PrepareError::Load(format!("common module not built: {unit_path}")))?;
        let mod_var = mod_var_name(unit_path);
        if let Some(caps) = ns_re.captures(clause_trimmed) {
            let local = caps[1].to_string();
            return Ok(format!("const {local} = {iife};"));
        }
        if let Some(caps) = named_re.captures(clause_trimmed) {
            let bindings = parse_named_list(caps[1].trim());
            if bindings.is_empty() {
                return Err(WrongImport.into());
            }
            let mut parts: Vec<String> = Vec::new();
            for (imported, local) in &bindings {
                if imported != local {
                    parts.push(format!("{imported}: {local}"));
                } else {
                    parts.push(imported.clone());
                }
            }
            let mut lines: Vec<String> = Vec::new();
            if declared_modules.insert(unit_path.to_string()) {
                lines.push(format!("const {mod_var} = {iife};"));
            }
            lines.push(format!("const {{ {} }} = {mod_var};", parts.join(", ")));
            return Ok(lines.join("\n"));
        }
        Err(WrongImport.into())
    }

    fn module_iife_cached(&self, unit_path: &str) -> Result<String, PrepareError> {
        self.module_iife
            .get(unit_path)
            .cloned()
            .ok_or_else(|| PrepareError::Load(format!("common module not built: {unit_path}")))
    }

    #[async_recursion]
    async fn ensure_module_iife(&mut self, unit_path: &str) -> Result<(), PrepareError> {
        if self.module_iife.contains_key(unit_path) {
            return Ok(());
        }
        if !self.visiting.insert(unit_path.to_string()) {
            return Err(PrepareError::Load(format!(
                "circular common import: {unit_path}"
            )));
        }

        let row = load_unit_for_path_scoped(
            &self.ctx.pool,
            &self.ctx.redis,
            self.ctx.project_id,
            self.ctx.stage_runtime_id,
            ProjectUnitType::Common,
            unit_path,
        )
        .await
        .map_err(|e| PrepareError::Load(e.to_string()))?
        .ok_or_else(|| PrepareError::Load(format!("common unit not found: {unit_path}")))?;

        let source = row
            .compiled_code
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| PrepareError::Load(format!("common unit has no code: {unit_path}")))?
            .to_string();

        for dep in collect_units_deps(&source) {
            if is_common_path(&dep) {
                self.ensure_module_iife(&dep).await?;
            } else {
                return Err(WrongImport.into());
            }
        }

        let body = self.prepare_common_module_body(&source)?;
        self.visiting.remove(unit_path);
        let iife = format!("(() => {{\n{body}\n}})()");
        self.module_iife.insert(unit_path.to_string(), iife);
        Ok(())
    }

    fn prepare_common_module_body(&mut self, source: &str) -> Result<String, PrepareError> {
        let mut body_lines: Vec<String> = Vec::new();
        let mut return_keys: Vec<String> = Vec::new();
        let mut return_spreads: Vec<String> = Vec::new();
        let mut declared_modules: HashSet<String> = HashSet::new();

        for line in source.lines() {
            if let Some(caps) = IMPORT_FROM_RE.captures(line) {
                let module = caps["mod"].to_string();
                let clause = caps["clause"].trim();
                if let Some(unit_path) = units_specifier(&module) {
                    let replacement =
                        self.rewrite_units_import_line_sync(unit_path, clause, &mut declared_modules)?;
                    for sub in replacement.lines() {
                        body_lines.push(sub.to_string());
                    }
                    continue;
                }
                if module == "@sdk" {
                    let replacement = rewrite_sdk_import_line(clause)?;
                    for sub in replacement.lines() {
                        body_lines.push(sub.to_string());
                    }
                    continue;
                }
                body_lines.push(line.to_string());
                continue;
            }
            if let Some(caps) = IMPORT_SIDE_RE.captures(line) {
                if units_specifier(&caps["mod"]).is_some() {
                    return Err(WrongImport.into());
                }
            }

            if let Some(caps) = EXPORT_STAR_FROM_RE.captures(line) {
                let unit_path = units_specifier(&caps["mod"]).ok_or(WrongImport)?;
                if !is_common_path(unit_path) {
                    return Err(WrongImport.into());
                }
                let iife = self.module_iife[unit_path].clone();
                let tmp = format!("__baal_reexp_{}", return_spreads.len());
                body_lines.push(format!("const {tmp} = {iife};"));
                return_spreads.push(tmp);
                continue;
            }

            if let Some(caps) = EXPORT_STAR_AS_FROM_RE.captures(line) {
                let unit_path = units_specifier(&caps["mod"]).ok_or(WrongImport)?;
                if !is_common_path(unit_path) {
                    return Err(WrongImport.into());
                }
                let ns = caps["ns"].to_string();
                let iife = self.module_iife_cached(unit_path)?;
                body_lines.push(format!("const {ns} = {iife};"));
                return_keys.push(ns);
                continue;
            }

            if let Some(caps) = EXPORT_NAMED_FROM_RE.captures(line) {
                let unit_path = units_specifier(&caps["mod"]).ok_or(WrongImport)?;
                if !is_common_path(unit_path) {
                    return Err(WrongImport.into());
                }
                let iife = self.module_iife_cached(unit_path)?;
                let tmp = format!("__baal_renamed_{}", body_lines.len());
                body_lines.push(format!("const {tmp} = {iife};"));
                for (imported, local) in parse_named_list(&caps["names"]) {
                    body_lines.push(format!("const {local} = {tmp}.{imported};"));
                    return_keys.push(local);
                }
                continue;
            }

            if let Some(caps) = EXPORT_NAMED_RE.captures(line) {
                for (imported, local) in parse_named_list(&caps["names"]) {
                    if imported != local {
                        body_lines.push(format!("const {local} = {imported};"));
                    }
                    return_keys.push(local);
                }
                continue;
            }

            if let Some(expr) = line.trim().strip_prefix("export default ") {
                let expr = expr.trim().trim_end_matches(';');
                body_lines.push(format!("const __baal_default = {expr}"));
                return_keys.push("__baal_default".to_string());
                continue;
            }

            if let Some(caps) = EXPORT_DECL_RE.captures(line) {
                let rest = caps["rest"].trim();
                body_lines.push(rest.to_string());
                if let Some(name) = export_name_from_decl(rest) {
                    return_keys.push(name);
                }
                continue;
            }

            body_lines.push(line.to_string());
        }

        let mut return_parts: Vec<String> = return_spreads.iter().map(|s| format!("...{s}")).collect();
        for key in return_keys {
            if key == "__baal_default" {
                return_parts.push("default: __baal_default".to_string());
            } else {
                return_parts.push(key);
            }
        }
        if return_parts.is_empty() {
            body_lines.push("return {};".to_string());
        } else {
            body_lines.push(format!("return {{ {} }};", return_parts.join(", ")));
        }

        Ok(body_lines.join("\n"))
    }
}

fn export_name_from_decl(rest: &str) -> Option<String> {
    let rest = rest.trim().trim_end_matches(';');
    if let Some(rest) = rest.strip_prefix("const ") {
        return rest.split('=').next()?.trim().split_whitespace().next().map(str::to_string);
    }
    if let Some(rest) = rest.strip_prefix("let ") {
        return rest.split('=').next()?.trim().split_whitespace().next().map(str::to_string);
    }
    if let Some(rest) = rest.strip_prefix("async function ") {
        return rest
            .split('(')
            .next()?
            .trim()
            .split_whitespace()
            .last()
            .map(str::to_string);
    }
    if let Some(rest) = rest.strip_prefix("function ") {
        return rest
            .split('(')
            .next()?
            .trim()
            .split_whitespace()
            .last()
            .map(str::to_string);
    }
    None
}

pub async fn prepare_compiled_unit_source(
    source: &str,
    ctx: &ImportResolveCtx,
) -> Result<String, PrepareError> {
    if !source.contains("@units/") && !source.contains("@sdk") {
        return Ok(source.to_string());
    }
    let mut resolver = ImportResolver {
        ctx,
        module_iife: HashMap::new(),
        visiting: HashSet::new(),
    };
    resolver.prepare_executing_source(source).await
}

pub async fn prepare_source_for_comm(
    source: &str,
    comm: &super::modules::sdk::SdkCommCtx,
) -> Result<String, PrepareError> {
    let project_id = Uuid::parse_str(&comm.project_id)
        .map_err(|e| PrepareError::Load(format!("invalid project_id: {e}")))?;
    prepare_compiled_unit_source(
        source,
        &ImportResolveCtx {
            pool: comm.pool.clone(),
            redis: comm.redis_conn.clone(),
            project_id,
            stage_runtime_id: comm.stage_runtime_id,
        },
    )
    .await
}

pub async fn prepare_source_scoped(
    source: &str,
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    stage_runtime_id: Option<Uuid>,
) -> Result<String, PrepareError> {
    prepare_compiled_unit_source(
        source,
        &ImportResolveCtx {
            pool: pool.clone(),
            redis: redis.clone(),
            project_id,
            stage_runtime_id,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_named_list_handles_aliases() {
        let v = parse_named_list("FACTOR as LOGGER_FACTOR, sharedSum");
        assert_eq!(
            v,
            vec![
                ("FACTOR".into(), "LOGGER_FACTOR".into()),
                ("sharedSum".into(), "sharedSum".into()),
            ]
        );
    }

    #[test]
    fn rejects_default_import_pattern() {
        let caps = Regex::new(r"^(\w+)$").unwrap();
        assert!(caps.is_match("defaultCanary"));
    }

    #[test]
    fn unit_type_from_common_path() {
        assert!(is_common_path("test.common.common.logger"));
        assert!(!is_common_path("test.actor-tests.actor.counter"));
    }

    #[test]
    fn rewrite_sdk_import_line_binds_globals() {
        let out = rewrite_sdk_import_line("{ sdk }").expect("named sdk import");
        assert_eq!(out, "const sdk = globalThis.sdk;");
    }

    #[test]
    fn import_from_re_matches_unnamed_forms() {
        let star = r#"import * from "@units/test.common.common.default-canary";"#;
        let bare = r#"import from "@units/test.common.common.default-canary";"#;
        let caps = IMPORT_FROM_RE.captures(star).expect("star line");
        assert_eq!(caps["clause"].trim(), "*");
        let caps = IMPORT_FROM_RE.captures(bare).expect("bare line");
        assert!(caps["clause"].trim().is_empty());
    }
}

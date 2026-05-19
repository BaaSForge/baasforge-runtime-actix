//! Import policy errors and validation for compiled unit sources.
//!
//! Module resolution and loading are handled by [`super::module_loader::BaalModules`].

use crate::database::{DbPool, SharedRedisConn};
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

impl std::fmt::Display for PrepareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongImport => f.write_str(WRONG_IMPORT_MSG),
            Self::UnnamedImport => f.write_str(UNNAMED_IMPORT_MSG),
            Self::Load(msg) => f.write_str(msg),
        }
    }
}

#[derive(Clone)]
pub struct ImportResolveCtx {
    pub pool: DbPool,
    pub redis: SharedRedisConn,
    pub project_id: Uuid,
    pub stage_runtime_id: Option<Uuid>,
}

pub fn validate_compiled_source(source: &str) -> Result<(), PrepareError> {
    super::module_loader::validate_import_policy(source)
}

pub async fn prepare_compiled_unit_source(
    source: &str,
    _ctx: &ImportResolveCtx,
) -> Result<String, PrepareError> {
    validate_compiled_source(source)?;
    Ok(source.to_string())
}

pub async fn prepare_source_for_comm(
    source: &str,
    _comm: &super::modules::sdk::SdkCommCtx,
) -> Result<String, PrepareError> {
    validate_compiled_source(source)?;
    Ok(source.to_string())
}

pub async fn prepare_source_scoped(
    source: &str,
    _pool: &DbPool,
    _redis: &SharedRedisConn,
    _project_id: Uuid,
    _stage_runtime_id: Option<Uuid>,
) -> Result<String, PrepareError> {
    validate_compiled_source(source)?;
    Ok(source.to_string())
}

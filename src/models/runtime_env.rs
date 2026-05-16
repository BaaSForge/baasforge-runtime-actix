use crate::schema::{project_runtime_encryption_keys, project_runtime_env_vars};
use chrono::{DateTime, Utc};
use diesel::prelude::{Queryable, Selectable};
use uuid::Uuid;

#[derive(Debug, Clone, Queryable, Selectable)]
#[diesel(table_name = project_runtime_env_vars)]
pub struct ProjectRuntimeEnvVarRow {
    pub id: Uuid,
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub key: String,
    pub stored_value: String,
    pub is_encrypted: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Queryable, Selectable)]
#[diesel(table_name = project_runtime_encryption_keys)]
pub struct ProjectRuntimeEncryptionKeyRow {
    pub runtime_id: Uuid,
    pub encryption_key: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

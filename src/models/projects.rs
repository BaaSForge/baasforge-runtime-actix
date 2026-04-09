use crate::schema::{project_releases, project_units};
use chrono::{DateTime, Utc};
use diesel::deserialize::{self, FromSql};
use diesel::pg::{Pg, PgValue};
use diesel::prelude::{Queryable, Selectable};
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::Jsonb;
use diesel_derive_enum::DbEnum;
use serde::{Deserialize, Serialize};
use std::io::Write;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq, DbEnum, Serialize, Clone, Deserialize)]
#[ExistingTypePath = "crate::schema::sql_types::PlatformEnvironmentType"]
#[DbValueStyle = "snake_case"]
#[serde(rename_all = "snake_case")]
pub enum PlatformEnvironmentType {
    Stage,
    Prod,
}

#[derive(
    Debug, Copy, Clone, PartialEq, Eq, Hash, DbEnum, Serialize, Deserialize,
)]
#[ExistingTypePath = "crate::schema::sql_types::ProjectUnitType"]
#[DbValueStyle = "snake_case"]
#[serde(rename_all = "snake_case")]
pub enum ProjectUnitType {
    Bootstrap,
    Action,
    Api,
    Command,
    Flow,
    Gateway,
    Projection,
    Query,
    Runtime,
    Schema,
    Timer,
}

impl ProjectUnitType {
    pub fn as_slug(&self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::Action => "action",
            Self::Api => "api",
            Self::Command => "command",
            Self::Flow => "flow",
            Self::Gateway => "gateway",
            Self::Projection => "projection",
            Self::Query => "query",
            Self::Runtime => "runtime",
            Self::Schema => "schema",
            Self::Timer => "timer",
        }
    }

    /// Parses the slug used in composite unit ids (`context.module.<slug>.…`). Inverse of [`Self::as_slug`].
    pub fn from_slug(s: &str) -> Option<Self> {
        [
            Self::Bootstrap,
            Self::Action,
            Self::Api,
            Self::Command,
            Self::Flow,
            Self::Gateway,
            Self::Projection,
            Self::Query,
            Self::Runtime,
            Self::Schema,
            Self::Timer,
        ]
        .into_iter()
        .find(|t| t.as_slug() == s)
    }
}

/// Stored JSON shape for [`project_releases::units_metadata`](crate::schema::project_releases).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnitIdEntry {
    /// Full unit id (`context.module.unit_type.unit_name.revision`), not the four-segment path alone.
    #[serde(rename = "unitId")]
    pub unit_id: String,
    #[serde(rename = "chatSessionId")]
    pub chat_session_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnitsMetadata {
    #[serde(default, rename = "newUnitIDs")]
    pub new_unit_ids: Vec<UnitIdEntry>,
    #[serde(default, rename = "combinedUnitIDs")]
    pub combined_unit_ids: Vec<UnitIdEntry>,
    #[serde(default, rename = "previousUnitIDs")]
    pub previous_unit_ids: Vec<UnitIdEntry>,
}

impl FromSql<Jsonb, Pg> for UnitsMetadata {
    fn from_sql(value: PgValue<'_>) -> deserialize::Result<Self> {
        let v = <serde_json::Value as FromSql<Jsonb, Pg>>::from_sql(value)?;
        serde_json::from_value(v).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
    }
}

impl ToSql<Jsonb, Pg> for UnitsMetadata {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Pg>) -> serialize::Result {
        let bytes = serde_json::to_vec(self)?;
        out.write_all(&bytes)?;
        Ok(IsNull::No)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Queryable, Selectable)]
#[diesel(table_name = project_releases)]
pub struct ProjectReleaseRow {
    pub id: Uuid,
    pub project_id: Uuid,
    pub units_metadata: Option<UnitsMetadata>,
    pub created_at: DateTime<Utc>,
    pub notes: Option<String>,
    pub chat_session_id: Option<Uuid>,
    pub is_stage: bool,
    pub revision: f64,
}

/// Row from [`project_units`](crate::schema::project_units). **Unit identity** is easy to mix up: see [`id`].
///
/// `id` (full dotted unit id) may match another row for the same `project_id` when `chat_session_id` differs.
/// Load/update paths must always filter by `chat_session_id` from the live release’s [`UnitsMetadata`], not only
/// by `id`, to avoid returning the wrong session’s row.
#[derive(Debug, Clone, Serialize, Deserialize, Queryable, Selectable)]
#[diesel(table_name = project_units)]
pub struct ProjectUnitRow {
    pub project_id: Uuid,
    pub code: Option<String>,
    pub compiled_code: Option<String>,
    pub explanation: Option<String>,
    pub chat_session_id: Uuid,
    pub unit_type: ProjectUnitType,
    pub is_deleted: bool,
    pub context_slug: String,
    pub module_slug: String,
    pub unit_name_slug: String,
    /// Full unit id: `context_slug.module_slug.unit_type_slug.unit_name_slug.revision` (five segments; the
    /// last segment is the numeric revision, same value as [`Self::revision`]). This is **not** the logical
    /// *unit path* (four segments without revision), which APIs and release metadata use for lookup.
    pub id: String,
    pub revision: i32,
}

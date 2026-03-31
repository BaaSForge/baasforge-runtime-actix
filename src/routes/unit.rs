//! HTTP handlers for runtime unit triggers. Resolution is implemented in
//! [`crate::services::project_release`]: each request loads the **live** prod or stage release, checks that the
//! unit path appears in that release’s `combinedUnitIDs` metadata (with `chatSessionId`), then uses Redis + Postgres
//! with **cache and DB keys scoped by chat session** so duplicate full unit ids across sessions cannot cross-talk.

use crate::libs::api_response::{api_error, api_success};
use crate::libs::unit_slug::is_valid_slug;
use crate::models::projects::ProjectUnitType;
use crate::routes::AppContext;
use crate::services::project_release::{
    load_unit_for_path_production, load_unit_for_path_stage, ServiceError,
};
use actix_web::{web, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

/// Path params for runtime units exposed at this API. The **type** segment of the composite unit id
/// is not in the URL; handlers pass [`ProjectUnitType::Api`] into [`logical_unit_path`] and the load helpers.
#[derive(Debug, Deserialize)]
pub struct ProdUnitPath {
    pub project_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub unit_name_slug: String,
}

#[derive(Debug, Deserialize)]
pub struct StageUnitPath {
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub unit_name_slug: String,
}

/// Logical path: `context.module.<unit_type>.<unit_name_slug>` where `unit_type` is the [`ProjectUnitType`]
/// argument; the third segment is `unit_type.as_slug()`.
fn logical_unit_path(
    params: &ProdUnitPath,
    unit_type: ProjectUnitType,
) -> Result<String, &'static str> {
    if !is_valid_slug(&params.context_slug) || !is_valid_slug(&params.module_slug) {
        return Err("invalid context or module slug");
    }
    if !is_valid_slug(&params.unit_name_slug) {
        return Err("invalid unit_name_slug");
    }
    Ok(format!(
        "{}.{}.{}.{}",
        params.context_slug,
        params.module_slug,
        unit_type.as_slug(),
        params.unit_name_slug
    ))
}

pub async fn handle_trigger_api_unit_production(
    ctx: web::Data<AppContext>,
    path: web::Path<ProdUnitPath>,
) -> HttpResponse {
    let params = path.into_inner();
    let unit_type = ProjectUnitType::Api;
    let unit_path = match logical_unit_path(&params, unit_type) {
        Ok(p) => p,
        Err(msg) => {
            return HttpResponse::BadRequest()
                .json(api_error(msg, json!({})));
        }
    };

    match load_unit_for_path_production(
        &ctx.pool,
        &ctx.redis_conn,
        params.project_id,
        unit_type,
        &unit_path,
    )
    .await
    {
        Ok(Some(unit)) => HttpResponse::Ok().json(api_success("unit", unit)),
        Ok(None) => HttpResponse::NotFound().json(api_error("unit not found", json!({}))),
        Err(e) => map_service_err(e),
    }
}

pub async fn handle_trigger_api_unit_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StageUnitPath>,
) -> HttpResponse {
    let params = path.into_inner();
    let prod = ProdUnitPath {
        project_id: params.project_id,
        context_slug: params.context_slug.clone(),
        module_slug: params.module_slug.clone(),
        unit_name_slug: params.unit_name_slug.clone(),
    };
    let unit_type = ProjectUnitType::Api;
    let unit_path = match logical_unit_path(&prod, unit_type) {
        Ok(p) => p,
        Err(msg) => {
            return HttpResponse::BadRequest()
                .json(api_error(msg, json!({})));
        }
    };

    match load_unit_for_path_stage(
        &ctx.pool,
        &ctx.redis_conn,
        params.project_id,
        params.runtime_id,
        unit_type,
        &unit_path,
    )
    .await
    {
        Ok(Some(unit)) => HttpResponse::Ok().json(api_success("unit", unit)),
        Ok(None) => HttpResponse::NotFound().json(api_error("unit not found", json!({}))),
        Err(e) => map_service_err(e),
    }
}

fn map_service_err(e: ServiceError) -> HttpResponse {
    tracing::error!(error = %e, "unit/release service error");
    match e {
        ServiceError::UnitPathTypeMismatch => {
            HttpResponse::BadRequest().json(api_error("unit path does not match unit type", json!({})))
        }
        ServiceError::LoadedUnitTypeMismatch => HttpResponse::InternalServerError()
            .json(api_error("unit type mismatch", json!({}))),
        _ => HttpResponse::InternalServerError().json(api_error("internal error", json!({}))),
    }
}

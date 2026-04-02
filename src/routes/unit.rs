//! HTTP handlers for runtime unit triggers. Resolution is implemented in
//! [`crate::services::project_release`]: each request loads the **live** prod or stage release, checks that the
//! unit path appears in that release’s `combinedUnitIDs` metadata (with `chatSessionId`), then uses Redis + Postgres
//! with **cache and DB keys scoped by chat session** so duplicate full unit ids across sessions cannot cross-talk.

use crate::libs::api_response::api_error;
use crate::libs::unit_js::{self, TriggerHttpSnapshot};
use crate::libs::unit_slug::is_valid_slug;
use crate::models::projects::{ProjectUnitRow, ProjectUnitType};
use crate::routes::AppContext;
use crate::services::project_release::{
    load_unit_for_path_production, load_unit_for_path_stage, ServiceError,
};
use actix_web::http::StatusCode;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

/// Max request body size forwarded into QuickJS `req` (bytes).
const TRIGGER_MAX_BODY_BYTES: usize = 512 * 1024;

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
    http_req: HttpRequest,
    body: web::Bytes,
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
        Ok(Some(unit)) => respond_trigger_unit(unit, &http_req, body).await,
        Ok(None) => HttpResponse::NotFound().json(api_error("unit not found", json!({}))),
        Err(e) => map_service_err(e),
    }
}

pub async fn handle_trigger_api_unit_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StageUnitPath>,
    http_req: HttpRequest,
    body: web::Bytes,
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
        Ok(Some(unit)) => respond_trigger_unit(unit, &http_req, body).await,
        Ok(None) => HttpResponse::NotFound().json(api_error("unit not found", json!({}))),
        Err(e) => map_service_err(e),
    }
}

fn trigger_http_snapshot(req: &HttpRequest, body: &web::Bytes) -> Result<TriggerHttpSnapshot, &'static str> {
    if body.len() > TRIGGER_MAX_BODY_BYTES {
        return Err("request body too large for unit trigger");
    }
    let method = req.method().as_str().to_string();
    let url = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| req.uri().path().to_string());
    let mut header_pairs = Vec::new();
    for (name, value) in req.headers().iter() {
        let value = value.to_str().unwrap_or("").to_string();
        header_pairs.push((name.as_str().to_string(), value));
    }
    let body_text = String::from_utf8_lossy(body).into_owned();
    Ok(TriggerHttpSnapshot {
        method,
        url,
        header_pairs,
        body_text,
    })
}

async fn respond_trigger_unit(unit: ProjectUnitRow, http_req: &HttpRequest, body: web::Bytes) -> HttpResponse {
    let code = match unit.code.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(c) => c.to_string(),
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("unit has no executable code", json!({})));
        }
    };
    let snapshot = match trigger_http_snapshot(http_req, &body) {
        Ok(s) => s,
        Err(msg) => return HttpResponse::PayloadTooLarge().json(api_error(msg, json!({}))),
    };
    let unit_id = unit.id.clone();
    let revision = unit.revision;
    let run_result = match tokio::task::spawn_blocking(move || unit_js::run_unit_handler(&code, &snapshot)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            tracing::error!(
                unit_id = %unit_id,
                revision,
                error = %e,
                "trigger unit: QuickJS execution failed"
            );
            return HttpResponse::BadRequest().json(api_error(
                "javascript execution failed",
                json!({ "detail": e }),
            ));
        }
        Err(join_err) => {
            if let Ok(payload) = join_err.try_into_panic() {
                tracing::error!(unit_id = %unit_id, revision, ?payload, "trigger unit: QuickJS task panicked");
            } else {
                tracing::error!(unit_id = %unit_id, revision, "trigger unit: QuickJS task cancelled");
            }
            return HttpResponse::InternalServerError()
                .json(api_error("javascript runner panicked", json!({})));
        }
    };

    let status =
        StatusCode::from_u16(run_result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut resp = HttpResponse::build(status);
    for (name, value) in run_result.headers {
        resp.append_header((name, value));
    }
    resp.body(run_result.body)
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

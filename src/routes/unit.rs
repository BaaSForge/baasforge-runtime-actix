//! HTTP handlers for runtime unit triggers. Resolution is implemented in
//! [`crate::services::project_release`]: each request loads the **live** prod or stage release, checks that the
//! unit path appears in that release’s `combinedUnitIDs` metadata (with `chatSessionId`), then uses Redis + Postgres
//! with **cache and DB keys scoped by chat session** so duplicate full unit ids across sessions cannot cross-talk.

use crate::libs::api_response::api_error;
use crate::libs::unit_js::{self, TriggerHttpSnapshot};
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::libs::unit_slug::is_valid_slug;
use crate::models::projects::{ProjectUnitRow, ProjectUnitType};
use crate::routes::AppContext;
use crate::services::project_release::{
    load_live_release_id_scoped, load_production_runtime_id_for_project, load_unit_for_path_production,
    load_unit_for_path_stage, ServiceError,
};
use actix_web::http::StatusCode;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tracing_opentelemetry::OpenTelemetrySpanExt;
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
        Ok(Some(unit)) => {
            let port = ctx.settings.port.parse::<u16>().unwrap_or(1500);
            let project_id_str = params.project_id.to_string();
            respond_trigger_unit(unit, &http_req, body, port, &ctx, &project_id_str, &unit_path, None).await
        }
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
        Ok(Some(unit)) => {
            let port = ctx.settings.port.parse::<u16>().unwrap_or(1500);
            let project_id_str = params.project_id.to_string();
            respond_trigger_unit(unit, &http_req, body, port, &ctx, &project_id_str, &unit_path, Some(params.runtime_id)).await
        }
        Ok(None) => HttpResponse::NotFound().json(api_error("unit not found", json!({}))),
        Err(e) => map_service_err(e),
    }
}

fn trigger_http_snapshot(req: &HttpRequest, body: &web::Bytes, server_port: u16) -> Result<TriggerHttpSnapshot, &'static str> {
    if body.len() > TRIGGER_MAX_BODY_BYTES {
        return Err("request body too large for unit trigger");
    }
    let method = req.method().as_str().to_string();
    let url = match req.uri().query() {
        Some(q) => format!("/?{}", q),
        None => "/".to_string(),
    };
    let trigger_path = req.uri().path().to_string();
    let mut header_pairs = Vec::new();
    for (name, value) in req.headers().iter() {
        let mut v = value.to_str().unwrap_or("").to_string();
        if name.as_str().eq_ignore_ascii_case("host") && !v.contains(':') {
            v = format!("{v}:{server_port}");
        }
        header_pairs.push((name.as_str().to_string(), v));
    }
    let body_text = String::from_utf8_lossy(body).into_owned();
    Ok(TriggerHttpSnapshot {
        method,
        url,
        header_pairs,
        body_text,
        trigger_path,
    })
}

async fn respond_trigger_unit(
    unit: ProjectUnitRow,
    http_req: &HttpRequest,
    body: web::Bytes,
    server_port: u16,
    ctx: &AppContext,
    project_id_str: &str,
    unit_path: &str,
    stage_runtime_id: Option<Uuid>,
) -> HttpResponse {
    invoke_api_unit(
        unit,
        http_req.clone(),
        body,
        server_port,
        ctx.clone(),
        project_id_str.to_string(),
        unit_path.to_string(),
        stage_runtime_id,
    )
    .await
}

async fn invoke_api_unit(
    unit: ProjectUnitRow,
    http_req: HttpRequest,
    body: web::Bytes,
    server_port: u16,
    ctx: AppContext,
    project_id_str: String,
    unit_path: String,
    stage_runtime_id: Option<Uuid>,
) -> HttpResponse {
    let span = tracing::Span::current();
    span.record("baal.unit.path", unit_path.as_str());
    span.record("baal.unit.id", unit.id.as_str());
    span.record("baal.unit.revision", unit.revision);
    let code = match unit.compiled_code.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(c) => c.to_string(),
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("unit has no executable compiled code", json!({})));
        }
    };
    let snapshot = match trigger_http_snapshot(&http_req, &body, server_port) {
        Ok(s) => s,
        Err(msg) => return HttpResponse::PayloadTooLarge().json(api_error(msg, json!({}))),
    };
    let project_uuid = match Uuid::parse_str(&project_id_str) {
        Ok(u) => u,
        Err(_) => {
            return HttpResponse::InternalServerError()
                .json(api_error("invalid project id", json!({})));
        }
    };
    let resolved_runtime_id = match stage_runtime_id {
        Some(rid) => Some(rid),
        None => load_production_runtime_id_for_project(&ctx.pool, project_uuid)
            .await
            .ok()
            .flatten(),
    };
    let live_release_id = load_live_release_id_scoped(
        &ctx.pool,
        &ctx.redis_conn,
        project_uuid,
        stage_runtime_id,
    )
    .await
    .ok()
    .flatten();
    span.record("baal.project.id", project_id_str.as_str());
    span.record(
        "baal.app.environment",
        if stage_runtime_id.is_some() {
            "stage"
        } else {
            "production"
        },
    );
    if let Some(r) = resolved_runtime_id {
        span.record("baal.runtime.id", tracing::field::display(r));
    }
    if let Some(rel) = live_release_id {
        span.record("baal.release.id", tracing::field::display(rel));
    }
    crate::telemetry::BaalHttpTriggerTraceIds {
        release_id: live_release_id,
        runtime_id: resolved_runtime_id,
    }
    .put_http_request(&http_req);
    let sdk_public_host = http_req
        .headers()
        .get(actix_web::http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_owned())
        .unwrap_or_else(|| "localhost".to_string());
    let sdk_trigger_base_path = snapshot.trigger_path.clone();
    let comm = Arc::new(SdkCommCtx {
        pool: ctx.pool.clone(),
        redis_conn: ctx.redis_conn.clone(),
        wf_redis: ctx.wf_redis.clone(),
        wf_nats: ctx.wf_nats_client.clone(),
        wf_js: ctx.wf_jetstream.clone(),
        wq_redis: ctx.wq_redis.clone(),
        wq_nats: ctx.wq_nats_client.clone(),
        wq_js: ctx.wq_jetstream.clone(),
        actor_redis: ctx.actor_redis.clone(),
        actor_nats: ctx.actor_nats_client.clone(),
        actor_js: ctx.actor_jetstream.clone(),
        actor_pg: ctx.actor_pg.clone(),
        actor_locks: ctx.actor_locks.clone(),
        project_id: project_id_str.clone(),
        source_unit_path: unit_path.clone(),
        source_instance_id: None,
        stage_runtime_id,
        resolved_runtime_id,
        sdk_public_host,
        sdk_trigger_base_path,
    });
    let unit_id = unit.id.clone();
    let revision = unit.revision;
    let parent_span = span.clone();
    let rid_owned = resolved_runtime_id.map(|u| u.to_string());
    let trigger_runtime = if stage_runtime_id.is_some() {
        Some("stage")
    } else {
        Some("production")
    };
    let parent_ctx = crate::telemetry::context_with_telemetry_baggage(
        span.context(),
        Some(project_id_str.as_str()),
        trigger_runtime,
        rid_owned.as_deref(),
    );
    let run_result = match tokio::task::spawn_blocking(move || {
        let _span_enter = parent_span.enter();
        let _otel = parent_ctx.attach();
        unit_js::run_unit_handler(&code, &snapshot, Some(comm))
    })
    .await
    {
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

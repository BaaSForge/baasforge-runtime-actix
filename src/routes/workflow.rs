use crate::libs::api_response::api_error;
use crate::libs::ids::new_uuid;
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::libs::unit_slug::is_valid_slug;
use crate::models::projects::ProjectUnitType;
use crate::routes::AppContext;
use crate::services::project_release::{load_unit_for_path_production, load_unit_for_path_stage};
use crate::services::workflow_engine::{self, SharedRedis};
use actix_web::{web, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Path param structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ProdPath {
    pub project_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub workflow_name_slug: String,
}

#[derive(Debug, Deserialize)]
pub struct StagePath {
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub workflow_name_slug: String,
}

#[derive(Debug, Deserialize)]
pub struct ProdInstancePath {
    pub project_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub workflow_name_slug: String,
    pub instance_id: String,
}

#[derive(Debug, Deserialize)]
pub struct StageInstancePath {
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub workflow_name_slug: String,
    pub instance_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ProdHandlerPath {
    pub project_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub workflow_name_slug: String,
    pub instance_id: String,
    pub handler_name: String,
}

#[derive(Debug, Deserialize)]
pub struct StageHandlerPath {
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub context_slug: String,
    pub module_slug: String,
    pub workflow_name_slug: String,
    pub instance_id: String,
    pub handler_name: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_valid_handler_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn build_unit_path(
    context_slug: &str,
    module_slug: &str,
    workflow_name_slug: &str,
) -> Result<String, &'static str> {
    if !is_valid_slug(context_slug) || !is_valid_slug(module_slug) {
        return Err("invalid context or module slug");
    }
    if !is_valid_slug(workflow_name_slug) {
        return Err("invalid workflow_name_slug");
    }
    Ok(format!(
        "{}.{}.workflow.{}",
        context_slug, module_slug, workflow_name_slug
    ))
}

fn require_wf_redis(ctx: &AppContext) -> Result<SharedRedis, HttpResponse> {
    ctx.wf_redis.clone().ok_or_else(|| {
        HttpResponse::ServiceUnavailable().json(api_error("workflow redis not available", json!({})))
    })
}

// ---------------------------------------------------------------------------
// Shared core logic
// ---------------------------------------------------------------------------

async fn do_start_workflow(
    ctx: &AppContext,
    project_id: Uuid,
    unit_path: &str,
    source: &str,
    body: &[u8],
) -> HttpResponse {
    let wf_redis = match require_wf_redis(ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let input_json = String::from_utf8_lossy(body).into_owned();
    let instance_id = new_uuid().to_string();
    let project_id_str = project_id.to_string();

    let comm = Arc::new(SdkCommCtx {
        pool: ctx.pool.clone(),
        redis_conn: ctx.redis_conn.clone(),
        wf_redis: Some(wf_redis.clone()),
        wf_nats: ctx.wf_nats_client.clone(),
        wf_js: ctx.wf_jetstream.clone(),
        wq_redis: ctx.wq_redis.clone(),
        wq_nats: ctx.wq_nats_client.clone(),
        wq_js: ctx.wq_jetstream.clone(),
        actor_redis: ctx.actor_redis.clone(),
        actor_nats: ctx.actor_nats_client.clone(),
        actor_js: ctx.actor_jetstream.clone(),
        actor_locks: ctx.actor_locks.clone(),
        project_id: project_id_str.clone(),
        source_unit_path: unit_path.to_string(),
        source_instance_id: Some(instance_id.clone()),
    });

    match workflow_engine::start_workflow(
        &wf_redis,
        &ctx.wf_nats_client,
        &ctx.wf_jetstream,
        &project_id_str,
        unit_path,
        &instance_id,
        &input_json,
        source,
        comm,
    )
    .await
    {
        Ok(iid) => HttpResponse::Ok().json(json!({
            "instanceId": iid,
            "status": "running",
        })),
        Err(e) => {
            tracing::error!(error = %e, "workflow start error");
            HttpResponse::InternalServerError().json(api_error(&e, json!({})))
        }
    }
}

async fn do_call_handler(
    ctx: &AppContext,
    project_id: Uuid,
    instance_id: &str,
    handler_name: &str,
    source: &str,
    body: &[u8],
) -> HttpResponse {
    if !is_valid_handler_name(handler_name) {
        return HttpResponse::BadRequest().json(api_error("invalid handler name", json!({})));
    }

    let wf_redis = match require_wf_redis(ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let handler_input = String::from_utf8_lossy(body).into_owned();
    let project_id_str = project_id.to_string();

    let comm = Arc::new(SdkCommCtx {
        pool: ctx.pool.clone(),
        redis_conn: ctx.redis_conn.clone(),
        wf_redis: Some(wf_redis.clone()),
        wf_nats: ctx.wf_nats_client.clone(),
        wf_js: ctx.wf_jetstream.clone(),
        wq_redis: ctx.wq_redis.clone(),
        wq_nats: ctx.wq_nats_client.clone(),
        wq_js: ctx.wq_jetstream.clone(),
        actor_redis: ctx.actor_redis.clone(),
        actor_nats: ctx.actor_nats_client.clone(),
        actor_js: ctx.actor_jetstream.clone(),
        actor_locks: ctx.actor_locks.clone(),
        project_id: project_id_str.clone(),
        source_unit_path: String::new(),
        source_instance_id: Some(instance_id.to_string()),
    });

    match workflow_engine::call_handler(
        &wf_redis,
        &ctx.wf_nats_client,
        &ctx.wf_jetstream,
        &project_id_str,
        instance_id,
        handler_name,
        &handler_input,
        source,
        comm,
    )
    .await
    {
        Ok(result) => {
            let val: serde_json::Value =
                serde_json::from_str(&result).unwrap_or(json!(result));
            HttpResponse::Ok().json(val)
        }
        Err(e) => {
            if e.contains("not found") {
                HttpResponse::NotFound().json(api_error(&e, json!({})))
            } else if e.contains("Unknown shared handler") {
                HttpResponse::BadRequest().json(api_error(&e, json!({})))
            } else {
                tracing::error!(error = %e, "workflow handler call error");
                HttpResponse::InternalServerError().json(api_error(&e, json!({})))
            }
        }
    }
}

async fn do_get_status(ctx: &AppContext, project_id: Uuid, instance_id: &str) -> HttpResponse {
    let wf_redis = match require_wf_redis(ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    match workflow_engine::get_workflow_status(
        &wf_redis,
        &project_id.to_string(),
        instance_id,
    )
    .await
    {
        Ok(status) => HttpResponse::Ok().json(status),
        Err(e) => {
            if e.contains("not found") {
                HttpResponse::NotFound().json(api_error(&e, json!({})))
            } else {
                tracing::error!(error = %e, "workflow status error");
                HttpResponse::InternalServerError().json(api_error(&e, json!({})))
            }
        }
    }
}

async fn do_cancel(ctx: &AppContext, project_id: Uuid, instance_id: &str) -> HttpResponse {
    let wf_redis = match require_wf_redis(ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    match workflow_engine::cancel_workflow(
        &wf_redis,
        &project_id.to_string(),
        instance_id,
    )
    .await
    {
        Ok(()) => HttpResponse::Ok().json(json!({ "status": "cancelled" })),
        Err(e) => {
            if e.contains("not found") {
                HttpResponse::NotFound().json(api_error(&e, json!({})))
            } else {
                HttpResponse::BadRequest().json(api_error(&e, json!({})))
            }
        }
    }
}

async fn do_get_result(ctx: &AppContext, project_id: Uuid, instance_id: &str) -> HttpResponse {
    let wf_redis = match require_wf_redis(ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let project_id_str = project_id.to_string();

    match workflow_engine::get_workflow_result(&wf_redis, &project_id_str, instance_id).await {
        Ok(Some(result)) => {
            let val: serde_json::Value = serde_json::from_str(&result).unwrap_or(json!(result));
            HttpResponse::Ok().json(json!({
                "status": "completed",
                "result": val,
            }))
        }
        Ok(None) => HttpResponse::Accepted().json(json!({
            "status": "pending",
            "message": "workflow has not completed yet",
        })),
        Err(e) => {
            if e.contains("not found") {
                HttpResponse::NotFound().json(api_error(&e, json!({})))
            } else {
                tracing::error!(error = %e, "workflow result error");
                HttpResponse::InternalServerError().json(api_error(&e, json!({})))
            }
        }
    }
}

/// Load compiled workflow source for a **production** unit path. Returns `Ok(source)` or an error
/// `HttpResponse` ready to be returned from the handler.
async fn load_source_production(
    ctx: &AppContext,
    project_id: Uuid,
    unit_path: &str,
) -> Result<String, HttpResponse> {
    let unit = load_unit_for_path_production(
        &ctx.pool,
        &ctx.redis_conn,
        project_id,
        ProjectUnitType::Workflow,
        unit_path,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "workflow load error");
        HttpResponse::InternalServerError().json(api_error("internal error", json!({})))
    })?
    .ok_or_else(|| {
        HttpResponse::NotFound().json(api_error("workflow unit not found", json!({})))
    })?;

    unit.compiled_code
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            HttpResponse::BadRequest()
                .json(api_error("workflow unit has no compiled code", json!({})))
        })
}

/// Load compiled workflow source for a **stage** unit path.
async fn load_source_stage(
    ctx: &AppContext,
    project_id: Uuid,
    runtime_id: Uuid,
    unit_path: &str,
) -> Result<String, HttpResponse> {
    let unit = load_unit_for_path_stage(
        &ctx.pool,
        &ctx.redis_conn,
        project_id,
        runtime_id,
        ProjectUnitType::Workflow,
        unit_path,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "workflow stage load error");
        HttpResponse::InternalServerError().json(api_error("internal error", json!({})))
    })?
    .ok_or_else(|| {
        HttpResponse::NotFound().json(api_error("workflow unit not found", json!({})))
    })?;

    unit.compiled_code
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            HttpResponse::BadRequest()
                .json(api_error("workflow unit has no compiled code", json!({})))
        })
}

// ---------------------------------------------------------------------------
// Production handlers
// ---------------------------------------------------------------------------

pub async fn start_workflow_production(
    ctx: web::Data<AppContext>,
    path: web::Path<ProdPath>,
    body: web::Bytes,
) -> HttpResponse {
    let p = path.into_inner();
    let unit_path = match build_unit_path(&p.context_slug, &p.module_slug, &p.workflow_name_slug) {
        Ok(up) => up,
        Err(msg) => return HttpResponse::BadRequest().json(api_error(msg, json!({}))),
    };
    let source = match load_source_production(&ctx, p.project_id, &unit_path).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    do_start_workflow(&ctx, p.project_id, &unit_path, &source, &body).await
}

pub async fn call_shared_handler_production(
    ctx: web::Data<AppContext>,
    path: web::Path<ProdHandlerPath>,
    body: web::Bytes,
) -> HttpResponse {
    let p = path.into_inner();
    let unit_path = match build_unit_path(&p.context_slug, &p.module_slug, &p.workflow_name_slug) {
        Ok(up) => up,
        Err(msg) => return HttpResponse::BadRequest().json(api_error(msg, json!({}))),
    };
    let source = match load_source_production(&ctx, p.project_id, &unit_path).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    do_call_handler(&ctx, p.project_id, &p.instance_id, &p.handler_name, &source, &body).await
}

pub async fn get_workflow_status_production(
    ctx: web::Data<AppContext>,
    path: web::Path<ProdInstancePath>,
) -> HttpResponse {
    let p = path.into_inner();
    do_get_status(&ctx, p.project_id, &p.instance_id).await
}

pub async fn cancel_workflow_production(
    ctx: web::Data<AppContext>,
    path: web::Path<ProdInstancePath>,
) -> HttpResponse {
    let p = path.into_inner();
    do_cancel(&ctx, p.project_id, &p.instance_id).await
}

pub async fn get_workflow_result_production(
    ctx: web::Data<AppContext>,
    path: web::Path<ProdInstancePath>,
) -> HttpResponse {
    let p = path.into_inner();
    do_get_result(&ctx, p.project_id, &p.instance_id).await
}

// ---------------------------------------------------------------------------
// Stage handlers
// ---------------------------------------------------------------------------

pub async fn start_workflow_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StagePath>,
    body: web::Bytes,
) -> HttpResponse {
    let p = path.into_inner();
    let unit_path = match build_unit_path(&p.context_slug, &p.module_slug, &p.workflow_name_slug) {
        Ok(up) => up,
        Err(msg) => return HttpResponse::BadRequest().json(api_error(msg, json!({}))),
    };
    let source = match load_source_stage(&ctx, p.project_id, p.runtime_id, &unit_path).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    do_start_workflow(&ctx, p.project_id, &unit_path, &source, &body).await
}

pub async fn call_shared_handler_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StageHandlerPath>,
    body: web::Bytes,
) -> HttpResponse {
    let p = path.into_inner();
    let unit_path = match build_unit_path(&p.context_slug, &p.module_slug, &p.workflow_name_slug) {
        Ok(up) => up,
        Err(msg) => return HttpResponse::BadRequest().json(api_error(msg, json!({}))),
    };
    let source = match load_source_stage(&ctx, p.project_id, p.runtime_id, &unit_path).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    do_call_handler(&ctx, p.project_id, &p.instance_id, &p.handler_name, &source, &body).await
}

pub async fn get_workflow_status_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StageInstancePath>,
) -> HttpResponse {
    let p = path.into_inner();
    do_get_status(&ctx, p.project_id, &p.instance_id).await
}

pub async fn cancel_workflow_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StageInstancePath>,
) -> HttpResponse {
    let p = path.into_inner();
    do_cancel(&ctx, p.project_id, &p.instance_id).await
}

pub async fn get_workflow_result_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<StageInstancePath>,
) -> HttpResponse {
    let p = path.into_inner();
    do_get_result(&ctx, p.project_id, &p.instance_id).await
}

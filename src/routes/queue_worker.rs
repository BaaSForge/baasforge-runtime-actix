use crate::libs::api_response::api_error;
use crate::libs::unit_slug::{is_valid_slug, normalize_filename_stem_to_slug};
use crate::models::projects::ProjectUnitType;
use crate::routes::AppContext;
use crate::services::project_release::{live_release_and_runtime_ids_for_scope, load_unit_for_path_scoped};
use crate::telemetry::BaalHttpTriggerTraceIds;
use crate::services::queue_worker_engine::{
    QueueWorkerRedis, cancel_queue_worker_run, enqueue_queue_worker_run, get_queue_worker_run_result,
    load_queue_worker_run_meta, queue_worker_url_stage_matches_meta,
};
use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::json;
use uuid::Uuid;

fn require_wq_redis(ctx: &AppContext) -> Result<QueueWorkerRedis, HttpResponse> {
    ctx.wq_redis.clone().ok_or_else(|| {
        HttpResponse::ServiceUnavailable()
            .json(api_error("queue_worker redis not available", json!({})))
    })
}

struct ParsedQueueWorkerTail {
    context_slug: String,
    module_slug: String,
    worker_name_slug: String,
    run_id: Option<String>,
    operation: QueueWorkerOperation,
}

enum QueueWorkerOperation {
    Enqueue,
    GetStatus,
    GetResult,
    Cancel,
}

/// Tail format (all segments URL-decoded, no leading slash):
///   enqueue:  `{context}/{module}/{worker_name_slug}`
///   status:   `{context}/{module}/{worker_name_slug}/{run_id}/status`
///   result:   `{context}/{module}/{worker_name_slug}/{run_id}/result`
///   cancel:   `{context}/{module}/{worker_name_slug}/{run_id}/cancel` (POST)
fn parse_queue_worker_tail(tail: &str, is_post: bool) -> Option<ParsedQueueWorkerTail> {
    let parts: Vec<&str> = tail.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 3 {
        return None;
    }
    let context_slug = parts[0];
    let module_slug = parts[1];
    if !is_valid_slug(context_slug) || !is_valid_slug(module_slug) {
        return None;
    }
    let worker_name_slug_raw = parts[2];
    let worker_name_slug = normalize_filename_stem_to_slug(worker_name_slug_raw)?;

    if parts.len() == 5 {
        let run_id = parts[3];
        let op_str = parts[4];
        if !run_id.is_empty() {
            let operation = match (is_post, op_str) {
                (true, "cancel") => QueueWorkerOperation::Cancel,
                (false, "status") => QueueWorkerOperation::GetStatus,
                (false, "result") => QueueWorkerOperation::GetResult,
                _ => return None,
            };
            return Some(ParsedQueueWorkerTail {
                context_slug: context_slug.to_string(),
                module_slug: module_slug.to_string(),
                worker_name_slug,
                run_id: Some(run_id.to_string()),
                operation,
            });
        }
    }

    if parts.len() == 3 && is_post {
        return Some(ParsedQueueWorkerTail {
            context_slug: context_slug.to_string(),
            module_slug: module_slug.to_string(),
            worker_name_slug,
            run_id: None,
            operation: QueueWorkerOperation::Enqueue,
        });
    }

    None
}

fn build_queue_worker_unit_path(context_slug: &str, module_slug: &str, worker_name_slug: &str) -> String {
    format!("{context_slug}.{module_slug}.queue_worker.{worker_name_slug}")
}

pub async fn handle_queue_worker_post(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, String)>,
    body: web::Bytes,
    req: HttpRequest,
) -> HttpResponse {
    let (project_id, tail) = path.into_inner();
    queue_worker_post_inner(ctx, project_id, None, tail, body, req).await
}

pub async fn handle_queue_worker_post_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, Uuid, String)>,
    body: web::Bytes,
    req: HttpRequest,
) -> HttpResponse {
    let (project_id, runtime_id, tail) = path.into_inner();
    queue_worker_post_inner(ctx, project_id, Some(runtime_id), tail, body, req).await
}

async fn queue_worker_post_inner(
    ctx: web::Data<AppContext>,
    project_id: Uuid,
    stage_runtime_id: Option<Uuid>,
    tail: String,
    body: web::Bytes,
    req: HttpRequest,
) -> HttpResponse {
    let parsed = match parse_queue_worker_tail(&tail, true) {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest().json(api_error(
                "invalid queue_worker URL path",
                json!({}),
            ));
        }
    };

    let wq_redis = match require_wq_redis(&ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let unit_path =
        build_queue_worker_unit_path(&parsed.context_slug, &parsed.module_slug, &parsed.worker_name_slug);

    match parsed.operation {
        QueueWorkerOperation::Enqueue => {
            let unit_exists = load_unit_for_path_scoped(
                &ctx.pool,
                &ctx.redis_conn,
                project_id,
                stage_runtime_id,
                ProjectUnitType::QueueWorker,
                &unit_path,
            )
            .await;
            match unit_exists {
                Ok(None) => {
                    return HttpResponse::NotFound()
                        .json(api_error("queue_worker unit not found", json!({})));
                }
                Err(e) => {
                    tracing::error!(error = %e, "queue_worker enqueue: load unit error");
                    return HttpResponse::InternalServerError()
                        .json(api_error("internal error", json!({})));
                }
                Ok(Some(_)) => {}
            }

            let (release_id, runtime_id) = live_release_and_runtime_ids_for_scope(
                &ctx.pool,
                &ctx.redis_conn,
                project_id,
                stage_runtime_id,
            )
            .await;
            BaalHttpTriggerTraceIds {
                release_id,
                runtime_id,
            }
            .put_http_request(&req);

            let data_json = String::from_utf8_lossy(&body).into_owned();
            let project_id_str = project_id.to_string();

            match enqueue_queue_worker_run(
                &wq_redis,
                &ctx.wq_nats_client,
                &ctx.wq_jetstream,
                &project_id_str,
                &unit_path,
                &data_json,
                stage_runtime_id,
            )
            .await
            {
                Ok(result) => HttpResponse::Ok().json(result),
                Err(e) => {
                    tracing::error!(error = %e, "queue_worker enqueue error");
                    HttpResponse::InternalServerError().json(api_error(&e, json!({})))
                }
            }
        }
        QueueWorkerOperation::Cancel => {
            let run_id = match parsed.run_id {
                Some(r) => r,
                None => {
                    return HttpResponse::BadRequest().json(api_error("missing run_id", json!({})))
                }
            };
            let project_id_str = project_id.to_string();
            match cancel_queue_worker_run(
                &wq_redis,
                &ctx.wq_nats_client,
                &project_id_str,
                &run_id,
                stage_runtime_id,
            )
            .await
            {
                Ok(result) => HttpResponse::Ok().json(result),
                Err(e) => {
                    if e.contains("not found") {
                        HttpResponse::NotFound().json(api_error(&e, json!({})))
                    } else if e.contains("terminal state") {
                        HttpResponse::BadRequest().json(api_error(&e, json!({})))
                    } else {
                        tracing::error!(error = %e, "queue_worker cancel error");
                        HttpResponse::InternalServerError().json(api_error(&e, json!({})))
                    }
                }
            }
        }
        _ => HttpResponse::MethodNotAllowed().json(api_error("method not allowed", json!({}))),
    }
}

pub async fn handle_queue_worker_get(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, String)>,
) -> HttpResponse {
    let (project_id, tail) = path.into_inner();
    queue_worker_get_inner(ctx, project_id, tail, None).await
}

pub async fn handle_queue_worker_get_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, Uuid, String)>,
) -> HttpResponse {
    let (project_id, runtime_id, tail) = path.into_inner();
    queue_worker_get_inner(ctx, project_id, tail, Some(runtime_id)).await
}

async fn queue_worker_get_inner(
    ctx: web::Data<AppContext>,
    project_id: Uuid,
    tail: String,
    url_stage_runtime_id: Option<Uuid>,
) -> HttpResponse {
    let parsed = match parse_queue_worker_tail(&tail, false) {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest().json(api_error(
                "invalid queue_worker URL path",
                json!({}),
            ));
        }
    };

    let wq_redis = match require_wq_redis(&ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let run_id = match parsed.run_id {
        Some(r) => r,
        None => return HttpResponse::BadRequest().json(api_error("missing run_id", json!({}))),
    };

    let project_id_str = project_id.to_string();

    let meta = match load_queue_worker_run_meta(&wq_redis, &project_id_str, &run_id).await {
        Ok(m) => m,
        Err(e) => {
            if e.contains("not found") {
                return HttpResponse::NotFound().json(api_error(&e, json!({})));
            }
            tracing::error!(error = %e, "queue_worker load meta error");
            return HttpResponse::InternalServerError().json(api_error(&e, json!({})));
        }
    };

    if !queue_worker_url_stage_matches_meta(url_stage_runtime_id, meta.stage_runtime_id) {
        let msg = "queue_worker run not found";
        return HttpResponse::NotFound().json(api_error(msg, json!({})));
    }

    match parsed.operation {
        QueueWorkerOperation::GetStatus => HttpResponse::Ok().json(json!({
            "status": meta.status,
            "attempt": meta.attempt,
            "enqueuedAt": meta.enqueued_at,
            "runId": run_id,
        })),
        QueueWorkerOperation::GetResult => {
            match get_queue_worker_run_result(&wq_redis, &project_id_str, &run_id).await {
                Ok(result) => HttpResponse::Ok().json(result),
                Err(e) => {
                    if e.contains("not found") {
                        HttpResponse::NotFound().json(api_error(&e, json!({})))
                    } else {
                        tracing::error!(error = %e, "queue_worker get_result error");
                        HttpResponse::InternalServerError().json(api_error(&e, json!({})))
                    }
                }
            }
        }
        _ => HttpResponse::MethodNotAllowed().json(api_error("method not allowed", json!({}))),
    }
}

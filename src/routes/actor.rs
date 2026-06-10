use crate::libs::api_response::api_error;
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::libs::unit_slug::is_valid_slug;
use crate::routes::AppContext;
use crate::models::actor_store;
use crate::services::actor_engine::{
    commit_state, delete_actor_state, get_actor_state_and_version, publish_actor_message, ActorRedis,
};
use crate::services::actor_worker::manager::{
    ActorRunInput, delete_actor, passivate_actor, run_actor_with_lock,
};
use crate::services::project_release::live_release_and_runtime_ids_for_scope;
use crate::telemetry::BaalHttpTriggerTraceIds;
use crate::libs::unit_js::actor_runner::ActorKind;
use actix_web::{web, HttpRequest, HttpResponse};
use bytes::BytesMut;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct ActorQuery {
    #[serde(rename = "await", default = "default_await")]
    pub await_result: bool,
}

fn default_await() -> bool {
    true
}

struct ParsedActorTail {
    context_slug: String,
    module_slug: String,
    unit_name_slug: String,
    actor_id: String,
    operation: ActorOperation,
}

enum ActorOperation {
    CallHandler(String),
    GetState,
    SnapshotPg,
    Passivate,
    TestEvictRedis,
    Delete,
}

fn parse_actor_tail(tail: &str, method: &str) -> Option<ParsedActorTail> {
    let parts: Vec<&str> = tail.split('/').filter(|s| !s.is_empty()).collect();

    match parts.len() {
        5 => {
            let ctx = parts[0];
            let module = parts[1];
            let unit = parts[2];
            let actor_id = parts[3];
            let op = parts[4];

            if !is_valid_slug(ctx) || !is_valid_slug(module) || !is_valid_slug(unit) {
                return None;
            }

            let operation = match (method, op) {
                ("POST", "passivate") => ActorOperation::Passivate,
                ("POST", "test-evict-redis") => ActorOperation::TestEvictRedis,
                ("GET", "state") => ActorOperation::GetState,
                ("GET", "snapshot-pg") => ActorOperation::SnapshotPg,
                ("POST", handler) if !handler.is_empty() => {
                    ActorOperation::CallHandler(handler.to_string())
                }
                _ => return None,
            };

            Some(ParsedActorTail {
                context_slug: ctx.to_string(),
                module_slug: module.to_string(),
                unit_name_slug: unit.to_string(),
                actor_id: actor_id.to_string(),
                operation,
            })
        }
        4 if method == "DELETE" => {
            let ctx = parts[0];
            let module = parts[1];
            let unit = parts[2];
            let actor_id = parts[3];

            if !is_valid_slug(ctx) || !is_valid_slug(module) || !is_valid_slug(unit) {
                return None;
            }

            Some(ParsedActorTail {
                context_slug: ctx.to_string(),
                module_slug: module.to_string(),
                unit_name_slug: unit.to_string(),
                actor_id: actor_id.to_string(),
                operation: ActorOperation::Delete,
            })
        }
        _ => None,
    }
}

fn build_actor_unit_path(
    context_slug: &str,
    module_slug: &str,
    unit_name_slug: &str,
) -> String {
    format!("{context_slug}.{module_slug}.actor.{unit_name_slug}")
}

#[tracing::instrument(
    name = "actor.invoke",
    skip(ctx, actor_redis, http_req, payload_json),
    fields(
        baal.project.id = %project_id_str,
        baal.unit.path = %unit_path,
        baal.actor.instance_id = %actor_id,
        baal.actor.handler = %handler_name,
        baal.app.environment = tracing::field::Empty,
        baal.runtime.id = tracing::field::Empty,
        baal.release.id = tracing::field::Empty,
        baal.actor.handler_payload = tracing::field::Empty,
    ),
)]
async fn invoke_actor_handler_http(
    ctx: web::Data<AppContext>,
    actor_redis: ActorRedis,
    project_id_str: String,
    unit_path: String,
    actor_id: String,
    handler_name: String,
    payload_json: String,
    stage_runtime_id: Option<Uuid>,
    http_req: HttpRequest,
) -> HttpResponse {
    let span = tracing::Span::current();
    span.record(
        "baal.actor.handler_payload",
        crate::libs::string::truncate_chars_for_log(&payload_json).as_str(),
    );
    span.record(
        "baal.app.environment",
        if stage_runtime_id.is_some() {
            "stage"
        } else {
            "production"
        },
    );
    let input = ActorRunInput {
        project_id: project_id_str.clone(),
        unit_path: unit_path.clone(),
        actor_id,
        handler: handler_name,
        payload_json,
        kind: ActorKind::Handler,
        alarm_name: None,
        error_msg: None,
    };
    let timeout_ms = 30_000u64;
    let resolved_runtime_id = match Uuid::parse_str(&project_id_str) {
        Ok(pid) => {
            live_release_and_runtime_ids_for_scope(
                &ctx.pool,
                &ctx.redis_conn,
                pid,
                stage_runtime_id,
            )
            .await
            .1
        }
        Err(_) => None,
    };
    let comm = Arc::new(SdkCommCtx {
        pool: ctx.pool.clone(),
        redis_conn: ctx.redis_conn.clone(),
        wf_redis: ctx.wf_redis.clone(),
        wf_nats: ctx.wf_nats_client.clone(),
        wf_js: ctx.wf_jetstream.clone(),
        wq_redis: ctx.wq_redis.clone(),
        wq_nats: ctx.wq_nats_client.clone(),
        wq_js: ctx.wq_jetstream.clone(),
        actor_redis: actor_redis.clone(),
        actor_nats: ctx.actor_nats_client.clone(),
        actor_js: ctx.actor_jetstream.clone(),
        actor_pg: ctx.actor_pg.clone(),
        actor_locks: ctx.actor_locks.clone(),
        project_id: project_id_str.clone(),
        source_unit_path: unit_path.clone(),
        source_instance_id: None,
        stage_runtime_id,
        resolved_runtime_id,
        sdk_public_host: "localhost".to_string(),
        sdk_trigger_base_path: String::new(),
    });
    let precomputed_scope_trace_ids = match Uuid::parse_str(&project_id_str) {
        Ok(pid) => {
            let (release_id, runtime_id) = live_release_and_runtime_ids_for_scope(
                &ctx.pool,
                &ctx.redis_conn,
                pid,
                stage_runtime_id,
            )
            .await;
            let ids = BaalHttpTriggerTraceIds {
                release_id,
                runtime_id,
            };
            ids.put_http_request(&http_req);
            Some(ids)
        }
        Err(_) => None,
    };
    let run_future = run_actor_with_lock(input, comm, precomputed_scope_trace_ids);
    match tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        run_future,
    )
    .await
    {
        Ok(Ok(out)) => {
            if out
                .error
                .as_deref()
                .map(|e| e.starts_with("UnknownHandler:"))
                .unwrap_or(false)
            {
                return HttpResponse::BadRequest()
                    .json(api_error(&out.error.unwrap_or_default(), json!({})));
            }
            HttpResponse::Ok().json(json!({ "result": out.result }))
        }
        Ok(Err(e)) => {
            if e.contains("UnknownHandler:") {
                return HttpResponse::BadRequest().json(api_error(&e, json!({})));
            }
            if e.contains("actor unit not found") {
                return HttpResponse::NotFound().json(api_error(&e, json!({})));
            }
            tracing::error!(error = %e, "[actor_route] handler error");
            HttpResponse::InternalServerError().json(api_error(&e, json!({})))
        }
        Err(_) => HttpResponse::GatewayTimeout().json(api_error("actor handler timed out", json!({}))),
    }
}

pub async fn handle_actor_post(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, String)>,
    payload: web::Payload,
    query: web::Query<ActorQuery>,
    req: HttpRequest,
) -> HttpResponse {
    let (project_id, tail) = path.into_inner();
    actor_post_inner(ctx, project_id, None, tail, payload, query, req).await
}

pub async fn handle_actor_post_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, Uuid, String)>,
    payload: web::Payload,
    query: web::Query<ActorQuery>,
    req: HttpRequest,
) -> HttpResponse {
    let (project_id, runtime_id, tail) = path.into_inner();
    actor_post_inner(ctx, project_id, Some(runtime_id), tail, payload, query, req).await
}

async fn actor_post_inner(
    ctx: web::Data<AppContext>,
    project_id: Uuid,
    stage_runtime_id: Option<Uuid>,
    tail: String,
    mut payload: web::Payload,
    query: web::Query<ActorQuery>,
    req: HttpRequest,
) -> HttpResponse {
    let parsed = match parse_actor_tail(&tail, "POST") {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("invalid actor URL path", json!({})));
        }
    };

    let actor_redis = ctx.actor_redis.clone();

    const MAX_BODY: usize = 32 * 1024 * 1024;

    let body = {
        let mut buf = BytesMut::new();
        let mut overflow = false;
        while let Some(chunk) = payload.next().await {
            match chunk {
                Ok(c) => {
                    if overflow {
                        continue;
                    }
                    buf.extend_from_slice(&c);
                    if buf.len() > MAX_BODY {
                        overflow = true;
                        buf.clear();
                    }
                }
                Err(_) => {
                    return HttpResponse::BadRequest()
                        .json(api_error("request read error", json!({})));
                }
            }
        }
        if overflow {
            return HttpResponse::PayloadTooLarge()
                .json(api_error("payload too large", json!({})));
        }
        buf.freeze()
    };

    let project_id_str = project_id.to_string();
    let unit_path = build_actor_unit_path(
        &parsed.context_slug,
        &parsed.module_slug,
        &parsed.unit_name_slug,
    );
    let payload_json = String::from_utf8_lossy(&body).into_owned();

    match parsed.operation {
        ActorOperation::Passivate => {
            passivate_actor(
                &actor_redis,
                ctx.actor_pg.as_ref(),
                &ctx.actor_nats_client,
                &project_id_str,
                &unit_path,
                &parsed.actor_id,
                stage_runtime_id,
                false,
                Some(&ctx.actor_locks),
            )
            .await;
            HttpResponse::Ok().json(json!({ "passivated": true }))
        }

        ActorOperation::TestEvictRedis => {
            if !ctx.settings.test_mode {
                return HttpResponse::NotFound()
                    .json(api_error("not found", json!({})));
            }
            delete_actor_state(
                &actor_redis,
                &project_id_str,
                stage_runtime_id,
                &unit_path,
                &parsed.actor_id,
            )
            .await;
            HttpResponse::Ok().json(json!({ "evicted": true }))
        }

        ActorOperation::CallHandler(handler_name) => {
            if query.await_result {
                invoke_actor_handler_http(
                    ctx.clone(),
                    actor_redis.clone(),
                    project_id_str.clone(),
                    unit_path.clone(),
                    parsed.actor_id.clone(),
                    handler_name,
                    payload_json,
                    stage_runtime_id,
                    req.clone(),
                )
                .await
            } else {
                let Some(ref js) = ctx.actor_jetstream else {
                    return HttpResponse::ServiceUnavailable()
                        .json(api_error("actor NATS not configured", json!({})));
                };

                let stage_s = stage_runtime_id.map(|u| u.to_string());
                match publish_actor_message(
                    js,
                    &project_id_str,
                    &unit_path,
                    &parsed.actor_id,
                    &handler_name,
                    &payload_json,
                    None,
                    stage_s.as_deref(),
                )
                .await
                {
                    Ok(_) => HttpResponse::Ok().json(json!({ "delivered": true })),
                    Err(e) => {
                        tracing::error!(error = %e, "[actor_route] mailbox publish failed");
                        HttpResponse::InternalServerError()
                            .json(api_error(&e, json!({})))
                    }
                }
            }
        }

        _ => HttpResponse::MethodNotAllowed().json(api_error("method not allowed", json!({}))),
    }
}

pub async fn handle_actor_get(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, String)>,
) -> HttpResponse {
    let (project_id, tail) = path.into_inner();
    actor_get_inner(ctx, project_id, None, tail).await
}

pub async fn handle_actor_get_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, Uuid, String)>,
) -> HttpResponse {
    let (project_id, runtime_id, tail) = path.into_inner();
    actor_get_inner(ctx, project_id, Some(runtime_id), tail).await
}

async fn actor_get_inner(
    ctx: web::Data<AppContext>,
    project_id: Uuid,
    stage_runtime_id: Option<Uuid>,
    tail: String,
) -> HttpResponse {
    let parsed = match parse_actor_tail(&tail, "GET") {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("invalid actor URL path", json!({})));
        }
    };

    let actor_redis = ctx.actor_redis.clone();

    let project_id_str = project_id.to_string();
    let unit_path = build_actor_unit_path(
        &parsed.context_slug,
        &parsed.module_slug,
        &parsed.unit_name_slug,
    );

    match parsed.operation {
        ActorOperation::GetState => {
            match get_actor_state_and_version(
                &actor_redis,
                &project_id_str,
                stage_runtime_id,
                &unit_path,
                &parsed.actor_id,
            )
            .await
            {
                Some((state, version)) => {
                    HttpResponse::Ok().json(json!({ "state": state, "version": version }))
                }
                None => {
                    if let Some(pool) = &ctx.actor_pg {
                        match actor_store::load_snapshot(
                            pool,
                            &project_id_str,
                            &unit_path,
                            &parsed.actor_id,
                            stage_runtime_id,
                        )
                        .await
                        {
                            Ok(Some((state, version))) => {
                                let _ = commit_state(
                                    &actor_redis,
                                    &project_id_str,
                                    stage_runtime_id,
                                    &unit_path,
                                    &parsed.actor_id,
                                    &state,
                                    version,
                                )
                                .await;
                                HttpResponse::Ok().json(json!({ "state": state, "version": version }))
                            }
                            Ok(None) => HttpResponse::NotFound()
                                .json(api_error("actor state not found", json!({}))),
                            Err(e) => {
                                tracing::error!(error = %e, "[actor_route] load_snapshot failed");
                                HttpResponse::InternalServerError()
                                    .json(api_error("actor snapshot load failed", json!({})))
                            }
                        }
                    } else {
                        HttpResponse::NotFound()
                            .json(api_error("actor state not found", json!({})))
                    }
                }
            }
        }

        ActorOperation::SnapshotPg => {
            if !ctx.settings.test_mode {
                return HttpResponse::NotFound()
                    .json(api_error("not found", json!({})));
            }
            let Some(pool) = ctx.actor_pg.as_ref() else {
                return HttpResponse::ServiceUnavailable()
                    .json(api_error("actor postgres not configured", json!({})));
            };
            match actor_store::load_snapshot(
                pool,
                &project_id_str,
                &unit_path,
                &parsed.actor_id,
                stage_runtime_id,
            )
            .await
            {
                Ok(Some((state, version))) => {
                    HttpResponse::Ok().json(json!({ "found": true, "state": state, "version": version }))
                }
                Ok(None) => HttpResponse::Ok().json(json!({ "found": false })),
                Err(e) => {
                    tracing::error!(error = %e, "[actor_route] snapshot-pg load failed");
                    HttpResponse::InternalServerError()
                        .json(api_error("actor snapshot load failed", json!({})))
                }
            }
        }
        _ => HttpResponse::MethodNotAllowed().json(api_error("method not allowed", json!({}))),
    }
}

pub async fn handle_actor_delete(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, String)>,
) -> HttpResponse {
    let (project_id, tail) = path.into_inner();
    actor_delete_inner(ctx, project_id, None, tail).await
}

pub async fn handle_actor_delete_stage(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, Uuid, String)>,
) -> HttpResponse {
    let (project_id, runtime_id, tail) = path.into_inner();
    actor_delete_inner(ctx, project_id, Some(runtime_id), tail).await
}

async fn actor_delete_inner(
    ctx: web::Data<AppContext>,
    project_id: Uuid,
    stage_runtime_id: Option<Uuid>,
    tail: String,
) -> HttpResponse {
    let parsed = match parse_actor_tail(&tail, "DELETE") {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("invalid actor URL path", json!({})));
        }
    };

    let actor_redis = ctx.actor_redis.clone();

    let project_id_str = project_id.to_string();
    let unit_path = build_actor_unit_path(
        &parsed.context_slug,
        &parsed.module_slug,
        &parsed.unit_name_slug,
    );

    match parsed.operation {
        ActorOperation::Delete => {
            delete_actor(
                &actor_redis,
                ctx.actor_pg.as_ref(),
                &ctx.actor_nats_client,
                &project_id_str,
                stage_runtime_id,
                &unit_path,
                &parsed.actor_id,
                Some(&ctx.actor_locks),
            )
            .await;
            HttpResponse::Ok().json(json!({ "deleted": true }))
        }
        _ => HttpResponse::MethodNotAllowed().json(api_error("method not allowed", json!({}))),
    }
}

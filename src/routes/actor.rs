use crate::libs::api_response::api_error;
use crate::libs::unit_slug::is_valid_slug;
use crate::routes::AppContext;
use crate::services::actor_engine::{
    ActorRedis, get_actor_state_and_version, publish_actor_message,
};
use crate::services::actor_worker::manager::{
    ActorRunInput, delete_actor, passivate_actor, run_actor_with_lock,
};
use crate::libs::unit_js::actor_runner::ActorKind;
use actix_web::{web, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

fn require_actor_redis(ctx: &AppContext) -> Result<ActorRedis, HttpResponse> {
    ctx.actor_redis.clone().ok_or_else(|| {
        HttpResponse::ServiceUnavailable()
            .json(api_error("actor redis not configured", json!({})))
    })
}

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
    Passivate,
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
                ("GET", "state") => ActorOperation::GetState,
                ("POST", handler) => {
                    if !is_valid_handler_name(handler) {
                        return None;
                    }
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

fn is_valid_actor_id(actor_id: &str) -> bool {
    !actor_id.is_empty()
        && actor_id.len() <= 512
        && actor_id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ':')
}

fn is_valid_handler_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.starts_with(|c: char| c.is_ascii_alphabetic())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub async fn handle_actor_post(
    ctx: web::Data<AppContext>,
    path: web::Path<(Uuid, String)>,
    body: web::Bytes,
    query: web::Query<ActorQuery>,
) -> HttpResponse {
    let (project_id, tail) = path.into_inner();

    let parsed = match parse_actor_tail(&tail, "POST") {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("invalid actor URL path", json!({})));
        }
    };

    if !is_valid_actor_id(&parsed.actor_id) {
        return HttpResponse::BadRequest()
            .json(api_error("invalid actor_id", json!({})));
    }

    let actor_redis = match require_actor_redis(&ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let project_id_str = project_id.to_string();
    let unit_path = build_actor_unit_path(
        &parsed.context_slug,
        &parsed.module_slug,
        &parsed.unit_name_slug,
    );
    let payload_json = String::from_utf8_lossy(&body).into_owned();
    let base_url = format!(
        "http://127.0.0.1:{}",
        ctx.settings.port
    );

    match parsed.operation {
        ActorOperation::Passivate => {
            passivate_actor(
                &actor_redis,
                &ctx.actor_nats_client,
                &project_id_str,
                &unit_path,
                &parsed.actor_id,
            )
            .await;
            HttpResponse::Ok().json(json!({ "passivated": true }))
        }

        ActorOperation::CallHandler(handler_name) => {
            if query.await_result {
                let crate::routes::AppContext {
                    pool,
                    redis_conn,
                    actor_nats_client,
                    actor_locks,
                    ..
                } = ctx.get_ref().clone();

                let input = ActorRunInput {
                    project_id: project_id_str.clone(),
                    unit_path: unit_path.clone(),
                    actor_id: parsed.actor_id.clone(),
                    handler: handler_name,
                    payload_json,
                    kind: ActorKind::Handler,
                    alarm_name: None,
                    error_msg: None,
                };

                let timeout_ms = 30_000u64;

                let run_future = run_actor_with_lock(
                    input,
                    &actor_redis,
                    &pool,
                    &redis_conn,
                    &actor_nats_client,
                    &actor_locks,
                    &base_url,
                );

                match tokio::time::timeout(
                    std::time::Duration::from_millis(timeout_ms),
                    run_future,
                )
                .await
                {
                    Ok(Ok(out)) => {
                        if out.error.as_deref().map(|e| e.starts_with("UnknownHandler:")).unwrap_or(false) {
                            return HttpResponse::BadRequest()
                                .json(api_error(&out.error.unwrap_or_default(), json!({})));
                        }
                        HttpResponse::Ok().json(json!({ "result": out.result }))
                    }
                    Ok(Err(e)) => {
                        if e.contains("UnknownHandler:") {
                            return HttpResponse::BadRequest()
                                .json(api_error(&e, json!({})));
                        }
                        if e.contains("actor unit not found") {
                            return HttpResponse::NotFound()
                                .json(api_error(&e, json!({})));
                        }
                        tracing::error!(error = %e, "[actor_route] handler error");
                        HttpResponse::InternalServerError()
                            .json(api_error(&e, json!({})))
                    }
                    Err(_) => HttpResponse::GatewayTimeout()
                        .json(api_error("actor handler timed out", json!({}))),
                }
            } else {
                let Some(ref js) = ctx.actor_jetstream else {
                    return HttpResponse::ServiceUnavailable()
                        .json(api_error("actor NATS not configured", json!({})));
                };

                match publish_actor_message(
                    js,
                    &project_id_str,
                    &unit_path,
                    &parsed.actor_id,
                    &handler_name,
                    &payload_json,
                    None,
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

    let parsed = match parse_actor_tail(&tail, "GET") {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("invalid actor URL path", json!({})));
        }
    };

    if !is_valid_actor_id(&parsed.actor_id) {
        return HttpResponse::BadRequest()
            .json(api_error("invalid actor_id", json!({})));
    }

    let actor_redis = match require_actor_redis(&ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

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
                &unit_path,
                &parsed.actor_id,
            )
            .await
            {
                Some((state, version)) => {
                    HttpResponse::Ok().json(json!({ "state": state, "version": version }))
                }
                None => HttpResponse::NotFound()
                    .json(api_error("actor state not found", json!({}))),
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

    let parsed = match parse_actor_tail(&tail, "DELETE") {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest()
                .json(api_error("invalid actor URL path", json!({})));
        }
    };

    if !is_valid_actor_id(&parsed.actor_id) {
        return HttpResponse::BadRequest()
            .json(api_error("invalid actor_id", json!({})));
    }

    let actor_redis = match require_actor_redis(&ctx) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

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
                &ctx.actor_nats_client,
                &project_id_str,
                &unit_path,
                &parsed.actor_id,
            )
            .await;
            HttpResponse::Ok().json(json!({ "deleted": true }))
        }
        _ => HttpResponse::MethodNotAllowed().json(api_error("method not allowed", json!({}))),
    }
}

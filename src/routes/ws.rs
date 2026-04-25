use actix_web::{web, HttpRequest, HttpResponse};
use futures::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

use crate::routes::AppContext;

#[derive(Deserialize)]
struct FilterMsg {
    action: String,
    #[serde(rename = "unitType")]
    unit_type: Option<String>,
    #[serde(rename = "instanceId")]
    instance_id: Option<String>,
}

fn build_subjects(
    project_id: &str,
    unit_type: Option<&str>,
    instance_id: Option<&str>,
) -> Vec<(String, &'static str)> {
    match (unit_type, instance_id) {
        (Some("queue-worker"), Some(iid)) => {
            vec![(format!("qw.events.{project_id}.queue-worker.{iid}"), "qw")]
        }
        (Some("queue-worker"), None) => {
            vec![(format!("qw.events.{project_id}.queue-worker.>"), "qw")]
        }
        (Some("actor"), Some(iid)) => {
            vec![(format!("actor.events.{project_id}.*.{iid}"), "actor")]
        }
        (Some("actor"), None) => {
            vec![(format!("actor.events.{project_id}.>"), "actor")]
        }
        (Some(ut), Some(iid)) => {
            vec![(format!("wf.events.{project_id}.{ut}.{iid}"), "wf")]
        }
        (Some(ut), None) => {
            vec![(format!("wf.events.{project_id}.{ut}.>"), "wf")]
        }
        (None, _) => vec![
            (format!("wf.events.{project_id}.>"), "wf"),
            (format!("qw.events.{project_id}.>"), "qw"),
            (format!("actor.events.{project_id}.>"), "actor"),
        ],
    }
}

fn include_nats_payload(text: &str, stage_filter: Option<&Uuid>) -> bool {
    match stage_filter {
        None => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
                return true;
            };
            match v.get("stageRuntimeId") {
                None | Some(serde_json::Value::Null) => true,
                Some(serde_json::Value::String(st)) => Uuid::parse_str(st).is_err(),
                Some(_) => false,
            }
        }
        Some(want) => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
                return false;
            };
            v.get("stageRuntimeId")
                .and_then(|x| x.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .map(|id| id == *want)
                .unwrap_or(false)
        }
    }
}

pub async fn ws_project_events(
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<String>,
    ctx: web::Data<AppContext>,
) -> Result<HttpResponse, actix_web::Error> {
    let project_id = path.into_inner();
    ws_project_events_impl(req, stream, ctx, project_id, None).await
}

pub async fn ws_project_events_stage(
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<(String, Uuid)>,
    ctx: web::Data<AppContext>,
) -> Result<HttpResponse, actix_web::Error> {
    let (project_id, runtime_id) = path.into_inner();
    ws_project_events_impl(req, stream, ctx, project_id, Some(runtime_id)).await
}

async fn ws_project_events_impl(
    req: HttpRequest,
    stream: web::Payload,
    ctx: web::Data<AppContext>,
    project_id: String,
    stage_filter: Option<Uuid>,
) -> Result<HttpResponse, actix_web::Error> {
    if ctx.wf_nats_client.is_none()
        && ctx.wq_nats_client.is_none()
        && ctx.actor_nats_client.is_none()
    {
        return Ok(HttpResponse::ServiceUnavailable().body("NATS not configured"));
    }

    let (resp, session, msg_stream) = actix_ws::handle(&req, stream)?;

    actix_web::rt::spawn(run_ws(
        session,
        msg_stream,
        ctx.wf_nats_client.clone(),
        ctx.wq_nats_client.clone(),
        ctx.actor_nats_client.clone(),
        project_id,
        stage_filter,
    ));

    Ok(resp)
}

async fn subscribe_all(
    subjects: &[(String, &str)],
    wf_nats: &Option<async_nats::Client>,
    wq_nats: &Option<async_nats::Client>,
    actor_nats: &Option<async_nats::Client>,
) -> Vec<async_nats::Subscriber> {
    let mut subs = Vec::new();
    for (subject, kind) in subjects {
        let client = match *kind {
            "qw" => wq_nats.as_ref(),
            "actor" => actor_nats.as_ref(),
            _ => wf_nats.as_ref(),
        };
        if let Some(c) = client {
            if let Ok(s) = c.subscribe(subject.clone()).await {
                subs.push(s);
            }
        }
    }
    subs
}

async fn run_ws(
    mut session: actix_ws::Session,
    mut msg_stream: actix_ws::MessageStream,
    wf_nats: Option<async_nats::Client>,
    wq_nats: Option<async_nats::Client>,
    actor_nats: Option<async_nats::Client>,
    project_id: String,
    stage_filter: Option<Uuid>,
) {
    let mut current_unit_type: Option<String> = None;
    let mut current_instance_id: Option<String> = None;

    'outer: loop {
        let subjects = build_subjects(
            &project_id,
            current_unit_type.as_deref(),
            current_instance_id.as_deref(),
        );

        let subs = subscribe_all(&subjects, &wf_nats, &wq_nats, &actor_nats).await;

        if subs.is_empty() {
            tracing::warn!("WS: no NATS subscriptions could be made");
            break;
        }

        let mut merged = futures::stream::select_all(subs);

        loop {
            tokio::select! {
                ws_msg = msg_stream.next() => {
                    match ws_msg {
                        Some(Ok(actix_ws::Message::Text(text))) => {
                            if let Ok(filter) = serde_json::from_str::<FilterMsg>(&text)
                                && filter.action == "subscribe"
                            {
                                current_unit_type = filter.unit_type;
                                current_instance_id = filter.instance_id;
                                drop(merged);
                                continue 'outer;
                            }
                        }
                        Some(Ok(actix_ws::Message::Ping(bytes))) => {
                            if session.pong(&bytes).await.is_err() {
                                break 'outer;
                            }
                        }
                        Some(Ok(actix_ws::Message::Close(_))) | None => break 'outer,
                        _ => {}
                    }
                }
                nats_msg = merged.next() => {
                    match nats_msg {
                        Some(msg) => {
                            if let Ok(text) = std::str::from_utf8(&msg.payload) {
                                if !include_nats_payload(text, stage_filter.as_ref()) {
                                    continue;
                                }
                                if session.text(text.to_owned()).await.is_err() {
                                    break 'outer;
                                }
                            }
                        }
                        None => break 'outer,
                    }
                }
            }
        }
    }

    let _ = session.close(None).await;
}

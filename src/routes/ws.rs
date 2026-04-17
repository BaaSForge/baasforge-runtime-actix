use actix_web::{web, HttpRequest, HttpResponse};
use futures::StreamExt;
use serde::Deserialize;

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

/// WebSocket endpoint: `GET /api/v1/ws/{project_id}`
///
/// Upgrades the connection and subscribes to NATS lifecycle event subjects,
/// forwarding every matching event as a JSON text frame.
///
/// Clients may send filter messages to narrow the subscription:
/// ```json
/// {"action":"subscribe","unitType":"queue-worker","instanceId":"abc-123"}
/// {"action":"subscribe","unitType":"workflow"}
/// {"action":"subscribe"}
/// ```
pub async fn ws_project_events(
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<String>,
    ctx: web::Data<AppContext>,
) -> Result<HttpResponse, actix_web::Error> {
    let project_id = path.into_inner();

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
                            if let Ok(text) = std::str::from_utf8(&msg.payload)
                                && session.text(text.to_owned()).await.is_err()
                            {
                                break 'outer;
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

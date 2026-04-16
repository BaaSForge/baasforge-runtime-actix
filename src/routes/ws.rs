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

enum WsSubjectSet {
    Single(String),
    Dual(String, String),
}

fn build_ws_subject_set(
    project_id: &str,
    unit_type: Option<&str>,
    instance_id: Option<&str>,
) -> WsSubjectSet {
    match (unit_type, instance_id) {
        (Some("queue-worker"), Some(iid)) => {
            WsSubjectSet::Single(format!("qw.events.{project_id}.queue-worker.{iid}"))
        }
        (Some("queue-worker"), None) => {
            WsSubjectSet::Single(format!("qw.events.{project_id}.queue-worker.>"))
        }
        (Some(ut), Some(iid)) => {
            WsSubjectSet::Single(format!("wf.events.{project_id}.{ut}.{iid}"))
        }
        (Some(ut), None) => {
            WsSubjectSet::Single(format!("wf.events.{project_id}.{ut}.>"))
        }
        (None, _) => WsSubjectSet::Dual(
            format!("wf.events.{project_id}.>"),
            format!("qw.events.{project_id}.>"),
        ),
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

    if ctx.wf_nats_client.is_none() && ctx.wq_nats_client.is_none() {
        return Ok(HttpResponse::ServiceUnavailable().body("NATS not configured"));
    }

    let (resp, session, msg_stream) = actix_ws::handle(&req, stream)?;

    actix_web::rt::spawn(run_ws(
        session,
        msg_stream,
        ctx.wf_nats_client.clone(),
        ctx.wq_nats_client.clone(),
        project_id,
    ));

    Ok(resp)
}

async fn subscribe_single(
    wf_nats: &Option<async_nats::Client>,
    wq_nats: &Option<async_nats::Client>,
    subject: &str,
) -> Option<async_nats::Subscriber> {
    let client = if subject.starts_with("qw.") {
        wq_nats.as_ref()?
    } else {
        wf_nats.as_ref()?
    };
    client.subscribe(subject.to_string()).await.ok()
}

async fn run_ws(
    mut session: actix_ws::Session,
    mut msg_stream: actix_ws::MessageStream,
    wf_nats: Option<async_nats::Client>,
    wq_nats: Option<async_nats::Client>,
    project_id: String,
) {
    let mut current_unit_type: Option<String> = None;
    let mut current_instance_id: Option<String> = None;

    'outer: loop {
        let subject_set = build_ws_subject_set(
            &project_id,
            current_unit_type.as_deref(),
            current_instance_id.as_deref(),
        );

        match subject_set {
            WsSubjectSet::Single(subject) => {
                let mut subscriber =
                    match subscribe_single(&wf_nats, &wq_nats, &subject).await {
                        Some(s) => s,
                        None => {
                            tracing::warn!(subject, "WS: NATS subscribe failed (client unavailable)");
                            break;
                        }
                    };

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
                                        drop(subscriber);
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
                        nats_msg = subscriber.next() => {
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
            WsSubjectSet::Dual(wf_subject, wq_subject) => {
                let mut streams: Vec<async_nats::Subscriber> = Vec::new();
                if let Some(c) = &wf_nats {
                    if let Ok(s) = c.subscribe(wf_subject).await {
                        streams.push(s);
                    }
                }
                if let Some(c) = &wq_nats {
                    if let Ok(s) = c.subscribe(wq_subject).await {
                        streams.push(s);
                    }
                }
                if streams.is_empty() {
                    break;
                }
                let mut merged = futures::stream::select_all(streams);

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
        }
    }

    let _ = session.close(None).await;
}

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

/// WebSocket endpoint: `GET /api/v1/ws/{project_id}`
///
/// Upgrades the connection to a WebSocket and subscribes to
/// `wf.events.{project_id}.>` on core NATS, forwarding every
/// matching event as a JSON text frame.
///
/// Clients may send filter messages to narrow the subscription:
/// ```json
/// {"action":"subscribe","unitType":"workflow","instanceId":"abc-123"}
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

    let Some(nats) = ctx.nats_client.clone() else {
        return Ok(HttpResponse::ServiceUnavailable().body("NATS not configured"));
    };

    let (resp, session, msg_stream) = actix_ws::handle(&req, stream)?;

    actix_web::rt::spawn(run_ws(session, msg_stream, nats, project_id));

    Ok(resp)
}

async fn run_ws(
    mut session: actix_ws::Session,
    mut msg_stream: actix_ws::MessageStream,
    nats: async_nats::Client,
    project_id: String,
) {
    let mut current_subject = format!("wf.events.{project_id}.>");

    'outer: loop {
        let mut subscriber = match nats.subscribe(current_subject.clone()).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "WS: NATS subscribe failed");
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
                                current_subject = build_subject(
                                    &project_id,
                                    filter.unit_type.as_deref(),
                                    filter.instance_id.as_deref(),
                                );
                                // Drop old subscription and resubscribe on next outer iteration
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

    let _ = session.close(None).await;
}

fn build_subject(project_id: &str, unit_type: Option<&str>, instance_id: Option<&str>) -> String {
    match (unit_type, instance_id) {
        (Some(ut), Some(iid)) => format!("wf.events.{project_id}.{ut}.{iid}"),
        (Some(ut), None) => format!("wf.events.{project_id}.{ut}.>"),
        _ => format!("wf.events.{project_id}.>"),
    }
}

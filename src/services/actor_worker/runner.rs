use async_nats::jetstream;
use futures::StreamExt;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::database::DbPool;
use crate::libs::unit_js::actor_runner::ActorKind;
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::routes::ActorLocks;
use crate::services::actor_engine::{ActorRedis, ACTOR_NATS_STREAM_SUBJECTS};
use crate::services::actor_worker::manager::{ActorRunInput, run_actor_with_lock};

pub async fn run_actor_consumer(
    actor_redis: ActorRedis,
    actor_js: Option<jetstream::Context>,
    actor_nats: Option<async_nats::Client>,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    stream_name: &str,
    consumer_name: &str,
    locks: ActorLocks,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(js) = actor_js else {
        info!("[actor_consumer] no JetStream context; fire-and-forget messages disabled");
        std::future::pending::<()>().await;
        return Ok(());
    };

    let subjects: Vec<String> = ACTOR_NATS_STREAM_SUBJECTS
        .iter()
        .map(|s| s.to_string())
        .collect();

    js.create_or_update_stream(async_nats::jetstream::stream::Config {
        name: stream_name.to_string(),
        subjects,
        ..Default::default()
    })
    .await?;

    let stream = js.get_stream(stream_name).await?;

    let filter_subject = "actor.*.*.*.*.msg".to_string();
    let consumer: async_nats::jetstream::consumer::Consumer<
        async_nats::jetstream::consumer::pull::Config,
    > = stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            durable_name: Some(consumer_name.to_string()),
            filter_subjects: vec![filter_subject],
            ack_wait: std::time::Duration::from_secs(300),
            ..Default::default()
        })
        .await?;

    info!(
        stream = %stream_name,
        consumer = %consumer_name,
        "[actor_consumer] JetStream pull consumer ready"
    );

    let mut messages = consumer.messages().await?;

    let actor_js_for_comm = Some(js);

    while let Some(result) = messages.next().await {
        match result {
            Ok(msg) => {
                let actor_redis = actor_redis.clone();
                let actor_nats = actor_nats.clone();
                let actor_js = actor_js_for_comm.clone();
                let pool = pool.clone();
                let redis_conn = redis_conn.clone();
                let locks = locks.clone();

                tokio::spawn(async move {
                    handle_actor_message(
                        msg, actor_redis, actor_js, actor_nats, pool, redis_conn, locks,
                    )
                    .await;
                });
            }
            Err(e) => {
                error!(error = %e, "[actor_consumer] consumer stream error");
            }
        }
    }

    Ok(())
}

async fn handle_actor_message(
    msg: async_nats::jetstream::Message,
    actor_redis: ActorRedis,
    actor_js: Option<async_nats::jetstream::Context>,
    actor_nats: Option<async_nats::Client>,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    locks: ActorLocks,
) {
    let payload: Option<serde_json::Value> = serde_json::from_slice(&msg.payload).ok();
    let Some(ref payload) = payload else {
        warn!("[actor_consumer] invalid payload, acking");
        let _ = msg.ack().await;
        return;
    };

    let project_id = payload
        .get("projectId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let unit_path = payload
        .get("unitPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let actor_id = payload
        .get("actorId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let handler = payload
        .get("handler")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let payload_json = payload
        .get("payload")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let reply_to = payload
        .get("replyTo")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let (Some(project_id), Some(unit_path), Some(actor_id), Some(handler)) =
        (project_id, unit_path, actor_id, handler)
    else {
        warn!("[actor_consumer] missing required fields, acking");
        let _ = msg.ack().await;
        return;
    };

    let input = ActorRunInput {
        project_id: project_id.clone(),
        unit_path: unit_path.clone(),
        actor_id: actor_id.clone(),
        handler,
        payload_json,
        kind: ActorKind::Handler,
        alarm_name: None,
        error_msg: None,
    };

    let comm = Arc::new(SdkCommCtx {
        pool,
        redis_conn,
        wf_redis: None,
        wf_nats: None,
        wf_js: None,
        wq_redis: None,
        wq_nats: None,
        wq_js: None,
        actor_redis: Some(actor_redis.clone()),
        actor_nats: actor_nats.clone(),
        actor_js,
        actor_locks: locks,
        project_id: project_id.clone(),
        source_unit_path: unit_path.clone(),
        source_instance_id: None,
    });

    let result = run_actor_with_lock(input, comm).await;

    if let Some(reply_subject) = reply_to {
        let reply_payload = match &result {
            Ok(out) => serde_json::json!({ "result": out.result }),
            Err(e) => serde_json::json!({ "error": e }),
        };
        if let Some(nc) = &actor_nats {
            let _ = nc
                .publish(
                    reply_subject,
                    bytes::Bytes::from(reply_payload.to_string()),
                )
                .await;
        }
    }

    let _ = msg.ack().await;
}

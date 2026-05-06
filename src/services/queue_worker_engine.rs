use async_nats::jetstream;
use async_nats::jetstream::stream;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;
pub type QueueWorkerRedis = Arc<Mutex<redis::aio::MultiplexedConnection>>;

fn wq_redis_key(project_id: &str, run_id: &str, suffix: &str) -> String {
    format!("wq:{project_id}:{run_id}:{suffix}")
}

pub const WQ_NATS_WORK_STREAM: &str = "WQ_WORK";
pub const WQ_NATS_WORK_STREAM_SUBJECTS: &[&str] = &["wq.*.*.work"];
pub const WQ_NATS_WORK_CONSUMER: &str = "wq_work_consumer";
pub const WQ_NATS_WORK_SUBJECT_PER_PROJECT: &str = "queue-worker";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueWorkerRunMeta {
    pub status: String,
    pub attempt: u32,
    #[serde(rename = "enqueuedAt")]
    pub enqueued_at: i64,
    pub name: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "stageRuntimeId", default, skip_serializing_if = "Option::is_none")]
    pub stage_runtime_id: Option<Uuid>,
}

pub async fn ensure_wq_work_stream(
    client: &async_nats::Client,
    stream_name: &str,
) -> Result<jetstream::stream::Stream, String> {
    let js = jetstream::new(client.clone());
    let subjects = WQ_NATS_WORK_STREAM_SUBJECTS
        .iter()
        .map(|s| s.to_string())
        .collect();
    js.create_or_update_stream(stream::Config {
        name: stream_name.to_string(),
        subjects,
        ..Default::default()
    })
    .await
    .map_err(|e| format!("WQ JetStream stream setup failed: {e}"))?;
    js.get_stream(stream_name)
        .await
        .map_err(|e| format!("WQ JetStream get_stream failed: {e}"))
}

pub async fn enqueue_queue_worker_run(
    redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    unit_path: &str,
    data_json: &str,
    stage_runtime_id: Option<Uuid>,
) -> Result<serde_json::Value, String> {
    let run_id = crate::libs::ids::new_uuid().to_string();
    let enqueued_at = chrono::Utc::now().timestamp_millis();

    let meta = QueueWorkerRunMeta {
        status: "queued".to_string(),
        attempt: 1,
        enqueued_at,
        name: unit_path.to_string(),
        run_id: run_id.clone(),
        stage_runtime_id,
    };
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let meta_key = wq_redis_key(project_id, &run_id, "meta");

    {
        let mut conn = redis.lock().await;
        let _: () = conn.set(&meta_key, &meta_json).await.map_err(|e| e.to_string())?;
    }

    publish_qw_event(
        nats,
        project_id,
        &run_id,
        "queueWorker.queued",
        serde_json::json!({ "workerPath": unit_path }),
        stage_runtime_id,
    )
    .await;

    let work_subject = format!("wq.{project_id}.{WQ_NATS_WORK_SUBJECT_PER_PROJECT}.work");
    let mut work_val = serde_json::json!({
        "runId": run_id,
        "data": data_json,
        "unitPath": unit_path,
    });
    if let Some(obj) = work_val.as_object_mut() {
        crate::telemetry::inject_traceparent_json_field(obj);
    }
    let work_payload = work_val.to_string();

    if let Some(js_ctx) = js {
        js_ctx
            .publish(work_subject, bytes::Bytes::from(work_payload))
            .await
            .map_err(|e| format!("WQ JetStream publish work failed: {e}"))?;
    } else if let Some(nats_client) = nats {
        nats_client
            .publish(work_subject, bytes::Bytes::from(work_payload))
            .await
            .map_err(|e| format!("WQ NATS publish work failed: {e}"))?;
    } else {
        return Err("NATS not configured: cannot enqueue queue worker run".to_string());
    }

    Ok(serde_json::json!({
        "runId": run_id,
        "status": "queued",
    }))
}

pub fn queue_worker_url_stage_matches_meta(url_stage: Option<Uuid>, meta_stage: Option<Uuid>) -> bool {
    match (url_stage, meta_stage) {
        (None, None) => true,
        (Some(u), Some(m)) => u == m,
        _ => false,
    }
}

pub async fn load_queue_worker_run_meta(
    redis: &QueueWorkerRedis,
    project_id: &str,
    run_id: &str,
) -> Result<QueueWorkerRunMeta, String> {
    let meta_key = wq_redis_key(project_id, run_id, "meta");
    let mut conn = redis.lock().await;
    let meta_json: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
    let Some(raw) = meta_json else {
        return Err("queue_worker run not found".to_string());
    };
    serde_json::from_str(&raw).map_err(|e| format!("invalid run meta: {e}"))
}

pub async fn get_queue_worker_run_status(
    redis: &QueueWorkerRedis,
    project_id: &str,
    run_id: &str,
) -> Result<serde_json::Value, String> {
    let meta = load_queue_worker_run_meta(redis, project_id, run_id).await?;
    Ok(serde_json::json!({
        "status": meta.status,
        "attempt": meta.attempt,
        "enqueuedAt": meta.enqueued_at,
        "runId": run_id,
    }))
}

pub async fn get_queue_worker_run_result(
    redis: &QueueWorkerRedis,
    project_id: &str,
    run_id: &str,
) -> Result<serde_json::Value, String> {
    let meta = load_queue_worker_run_meta(redis, project_id, run_id).await?;
    let result_key = wq_redis_key(project_id, run_id, "result");
    let mut conn = redis.lock().await;
    let result_json: Option<String> = conn.get(&result_key).await.map_err(|e| e.to_string())?;
    let result_val = result_json
        .as_deref()
        .map(|r| serde_json::from_str::<serde_json::Value>(r).unwrap_or_else(|_| serde_json::json!(r)))
        .unwrap_or(serde_json::Value::Null);

    Ok(serde_json::json!({
        "status": meta.status,
        "result": result_val,
    }))
}

pub async fn cancel_queue_worker_run(
    redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    run_id: &str,
    url_stage_runtime_id: Option<Uuid>,
) -> Result<serde_json::Value, String> {
    let meta_key = wq_redis_key(project_id, run_id, "meta");
    let mut conn = redis.lock().await;
    let meta_json: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
    let Some(raw) = meta_json else {
        return Err("queue_worker run not found".to_string());
    };
    let mut meta: QueueWorkerRunMeta =
        serde_json::from_str(&raw).map_err(|e| format!("invalid run meta: {e}"))?;

    if !queue_worker_url_stage_matches_meta(url_stage_runtime_id, meta.stage_runtime_id) {
        return Err("queue_worker run not found".to_string());
    }

    if meta.status == "cancelled" {
        return Ok(serde_json::json!({ "status": "cancelled" }));
    }
    if meta.status == "completed" || meta.status == "dead_letter" {
        return Err(format!(
            "cannot cancel: run is already in terminal state '{}'",
            meta.status
        ));
    }

    meta.status = "cancelled".to_string();
    let updated = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let _: () = conn.set(&meta_key, &updated).await.map_err(|e| e.to_string())?;
    drop(conn);

    publish_qw_event(
        nats,
        project_id,
        run_id,
        "queueWorker.cancelled",
        serde_json::json!({}),
        meta.stage_runtime_id,
    )
    .await;

    Ok(serde_json::json!({ "status": "cancelled" }))
}

pub async fn publish_qw_event(
    nats: &Option<async_nats::Client>,
    project_id: &str,
    run_id: &str,
    event_type: &str,
    extra: serde_json::Value,
    stage_runtime_id: Option<Uuid>,
) {
    let Some(nats_client) = nats else { return };
    let subject = format!("qw.events.{project_id}.queue-worker.{run_id}");
    let mut payload = serde_json::json!({
        "event": event_type,
        "runId": run_id,
        "projectId": project_id,
        "timestamp": chrono::Utc::now().timestamp_millis(),
    });
    if let Some(rid) = stage_runtime_id {
        if let serde_json::Value::Object(ref mut obj) = payload {
            obj.insert("stageRuntimeId".to_string(), serde_json::json!(rid.to_string()));
        }
    }
    if let serde_json::Value::Object(extras) = extra
        && let serde_json::Value::Object(ref mut obj) = payload
    {
        obj.extend(extras);
    }
    if let Err(e) = nats_client
        .publish(subject, bytes::Bytes::from(payload.to_string()))
        .await
    {
        tracing::warn!(error = %e, "publish_qw_event failed");
    }
}

pub fn set_queue_worker_run_meta_sync<'a>(
    conn: &'a mut redis::aio::MultiplexedConnection,
    project_id: &'a str,
    run_id: &'a str,
    status: &'a str,
    attempt: u32,
    enqueued_at: i64,
    unit_path: &'a str,
    stage_runtime_id: Option<Uuid>,
) -> impl std::future::Future<Output = Result<(), String>> + 'a {
    let meta = QueueWorkerRunMeta {
        status: status.to_string(),
        attempt,
        enqueued_at,
        name: unit_path.to_string(),
        run_id: run_id.to_string(),
        stage_runtime_id,
    };
    let meta_key = wq_redis_key(project_id, run_id, "meta");
    async move {
        let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
        let _: () = conn.set(&meta_key, &json).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

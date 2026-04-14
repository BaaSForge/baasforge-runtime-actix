use async_nats::jetstream;
use async_nats::jetstream::stream;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::libs::unit_js::workflow_runner::{
    run_workflow_handler, WorkflowExecutionContext, WorkflowExecutionResult,
};

pub type SharedRedis = Arc<Mutex<redis::aio::MultiplexedConnection>>;

fn redis_key(project_id: &str, instance_id: &str, suffix: &str) -> String {
    format!("wf:{project_id}:{instance_id}:{suffix}")
}

/// Get or create the durable JetStream stream that captures all workflow wake subjects.
/// The stream subject `wf.*.*.wake` matches every wake publish, including immediate
/// core-NATS publishes (promise resolved, retry exhausted) which are auto-captured.
pub async fn ensure_wf_wake_stream(
    client: &async_nats::Client,
    stream_name: &str,
) -> Result<jetstream::stream::Stream, String> {
    let js = jetstream::new(client.clone());
    js.get_or_create_stream(stream::Config {
        name: stream_name.to_string(),
        subjects: vec!["wf.*.*.wake".to_string()],
        ..Default::default()
    })
    .await
    .map_err(|e| format!("JetStream stream setup failed: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowMeta {
    pub name: String,
    pub status: String,
    pub input: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "callerTriggered", default)]
    pub caller_triggered: bool,
}

/// Start a new workflow instance.
/// Returns the instance ID on success.
pub async fn start_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    unit_path: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
) -> Result<String, String> {
    // Workflow-name dedup: only return an existing instance if it is still
    // actively running or suspended. Completed/failed/cancelled instances are
    // NOT reused so that subsequent triggers always start a fresh execution.
    let name_key = format!("wf:{project_id}:name:{unit_path}");
    {
        let mut conn = redis.lock().await;
        let existing_iid: Option<String> = conn.get(&name_key).await.map_err(|e| e.to_string())?;
        if let Some(eid) = existing_iid {
            let eid_meta_key = redis_key(project_id, &eid, "meta");
            let eid_meta: Option<String> = conn.get(&eid_meta_key).await.map_err(|e| e.to_string())?;
            if let Some(raw) = eid_meta {
                if let Ok(meta) = serde_json::from_str::<WorkflowMeta>(&raw) {
                    if meta.status == "running" || meta.status == "suspended" {
                        return Ok(eid);
                    }
                }
            }
        }
    }

    let meta_key = redis_key(project_id, instance_id, "meta");
    let meta = WorkflowMeta {
        name: unit_path.to_string(),
        status: "running".to_string(),
        input: input_json.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        caller_triggered: false,
    };
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;

    {
        let mut conn = redis.lock().await;
        let _: () = conn.set(&meta_key, &meta_json).await.map_err(|e| e.to_string())?;
        let _: () = conn.set(&name_key, instance_id).await.map_err(|e| e.to_string())?;
    }

    execute_workflow(redis, nats, js, project_id, instance_id, input_json, source, None, None).await?;

    Ok(instance_id.to_string())
}

/// Resume a workflow after a wake signal (timer or promise resolution).
pub async fn resume_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    instance_id: &str,
    source: &str,
) -> Result<(), String> {
    let meta_key = redis_key(project_id, instance_id, "meta");
    let meta_json: String = {
        let mut conn = redis.lock().await;
        conn.get(&meta_key)
            .await
            .map_err(|e| e.to_string())?
    };
    let meta: WorkflowMeta = serde_json::from_str(&meta_json)
        .map_err(|e| format!("invalid workflow meta: {e}"))?;

    if meta.status == "completed" || meta.status == "failed" || meta.status == "cancelled" {
        return Ok(());
    }

    execute_workflow(redis, nats, js, project_id, instance_id, &meta.input, source, None, None).await?;
    Ok(())
}

/// Invoke a shared handler on a running workflow instance.
pub async fn call_handler(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    instance_id: &str,
    handler_name: &str,
    handler_input_json: &str,
    source: &str,
) -> Result<String, String> {
    let handler_result = execute_workflow(
        redis,
        nats,
        js,
        project_id,
        instance_id,
        "",
        source,
        Some(handler_name),
        Some(handler_input_json),
    )
    .await?;

    // After the handler (which may have resolved a durable promise), eagerly
    // resume the main workflow so the caller sees updated state immediately
    // without waiting for the async NATS wake roundtrip.
    let _ = resume_workflow(redis, nats, js, project_id, instance_id, source).await;

    Ok(handler_result)
}

/// Cancel a running or suspended workflow.
pub async fn cancel_workflow(
    redis: &SharedRedis,
    project_id: &str,
    instance_id: &str,
) -> Result<(), String> {
    let meta_key = redis_key(project_id, instance_id, "meta");
    let mut conn = redis.lock().await;
    let meta_json: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
    let Some(raw) = meta_json else {
        return Err("workflow instance not found".to_string());
    };
    let mut meta: WorkflowMeta = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid workflow meta: {e}"))?;

    if meta.status == "completed" || meta.status == "failed" {
        return Err(format!("workflow already {}", meta.status));
    }

    meta.status = "cancelled".to_string();
    let updated = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let _: () = conn.set(&meta_key, &updated).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the status of a workflow instance including step states and stored state.
pub async fn get_workflow_status(
    redis: &SharedRedis,
    project_id: &str,
    instance_id: &str,
) -> Result<serde_json::Value, String> {
    let meta_key = redis_key(project_id, instance_id, "meta");
    let result_key = redis_key(project_id, instance_id, "result");
    let suspended_key = redis_key(project_id, instance_id, "suspended");

    let mut conn = redis.lock().await;
    let meta_json: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
    let result_json: Option<String> = conn.get(&result_key).await.map_err(|e| e.to_string())?;
    let suspended_json: Option<String> = conn.get(&suspended_key).await.map_err(|e| e.to_string())?;

    let Some(meta_raw) = meta_json else {
        return Err("workflow instance not found".to_string());
    };

    let mut meta: serde_json::Value = serde_json::from_str(&meta_raw)
        .map_err(|e| format!("invalid meta: {e}"))?;

    if let Some(susp_raw) = suspended_json {
        if let Ok(susp_val) = serde_json::from_str::<serde_json::Value>(&susp_raw) {
            meta["suspended"] = susp_val;
        }
    }

    let mut resp = serde_json::json!({
        "meta": meta,
    });

    if let Some(r) = result_json {
        let result_val: serde_json::Value = serde_json::from_str(&r).unwrap_or(serde_json::json!(r));
        resp["result"] = result_val;
    }

    Ok(resp)
}

/// Get the final result of a completed workflow. Returns `None` if not yet completed.
pub async fn get_workflow_result(
    redis: &SharedRedis,
    project_id: &str,
    instance_id: &str,
) -> Result<Option<String>, String> {
    let result_key = redis_key(project_id, instance_id, "result");
    let mut conn = redis.lock().await;
    conn.get(&result_key).await.map_err(|e| e.to_string())
}

/// Resolve a durable promise from outside (e.g., from a route handler).
pub async fn resolve_promise(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    instance_id: &str,
    promise_name: &str,
    value_json: &str,
) -> Result<(), String> {
    let rkey = redis_key(project_id, instance_id, &format!("promise:{promise_name}"));
    let value = serde_json::json!({
        "status": "resolved",
        "value": value_json,
    })
    .to_string();

    let mut conn = redis.lock().await;
    let _: () = conn.set(&rkey, &value).await.map_err(|e| e.to_string())?;
    drop(conn);

    if let Some(nats_client) = nats {
        let subject = format!("wf.{project_id}.{instance_id}.wake");
        let payload = serde_json::json!({
            "reason": "promise_resolved",
            "promise": promise_name,
        })
        .to_string();
        nats_client
            .publish(subject, bytes::Bytes::from(payload))
            .await
            .map_err(|e| format!("nats publish wake failed: {e}"))?;
    }

    Ok(())
}

/// Parse a duration value (number in ms, or object with unit fields) into milliseconds.
fn duration_to_ms(val: Option<&serde_json::Value>) -> Option<f64> {
    let v = val?;
    if let Some(n) = v.as_f64() {
        return Some(n.max(0.0));
    }
    if let Some(obj) = v.as_object() {
        let mut ms = 0.0;
        if let Some(n) = obj.get("milliseconds").and_then(|v| v.as_f64()) { ms += n; }
        if let Some(n) = obj.get("seconds").and_then(|v| v.as_f64()) { ms += n * 1000.0; }
        if let Some(n) = obj.get("minutes").and_then(|v| v.as_f64()) { ms += n * 60000.0; }
        if let Some(n) = obj.get("hours").and_then(|v| v.as_f64()) { ms += n * 3600000.0; }
        if let Some(n) = obj.get("days").and_then(|v| v.as_f64()) { ms += n * 86400000.0; }
        return Some(ms.max(0.0));
    }
    None
}

// -- Internal helpers --

/// Load all step/sleep/promise state from Redis for replay.
async fn load_execution_context(
    redis: &SharedRedis,
    project_id: &str,
    instance_id: &str,
) -> Result<(HashMap<String, String>, HashMap<String, String>, HashMap<String, String>), String> {
    let mut conn = redis.lock().await;
    let prefix = format!("wf:{project_id}:{instance_id}:");

    // SCAN for all keys with the instance prefix
    let pattern = format!("{prefix}*");
    let mut steps: HashMap<String, String> = HashMap::new();
    let mut sleeps: HashMap<String, String> = HashMap::new();
    let mut promises: HashMap<String, String> = HashMap::new();

    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(&pattern)
        .query_async(&mut *conn)
        .await
        .map_err(|e| format!("redis KEYS failed: {e}"))?;

    for key in &keys {
        let suffix = key.strip_prefix(&prefix).unwrap_or(key);
        if let Some(step_name) = suffix.strip_prefix("step:") {
            let val: Option<String> = conn.get(key).await.map_err(|e| e.to_string())?;
            if let Some(v) = val {
                steps.insert(step_name.to_string(), v);
            }
        } else if let Some(sleep_name) = suffix.strip_prefix("sleep:") {
            let val: Option<String> = conn.get(key).await.map_err(|e| e.to_string())?;
            if let Some(v) = val {
                sleeps.insert(sleep_name.to_string(), v);
            }
        } else if let Some(promise_name) = suffix.strip_prefix("promise:") {
            let val: Option<String> = conn.get(key).await.map_err(|e| e.to_string())?;
            if let Some(v) = val {
                promises.insert(promise_name.to_string(), v);
            }
        }
    }

    Ok((steps, sleeps, promises))
}

async fn execute_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
    handler_name: Option<&str>,
    handler_input_json: Option<&str>,
) -> Result<String, String> {
    let pid = project_id.to_string();
    let iid = instance_id.to_string();

    let (steps, sleeps, promises) = load_execution_context(redis, &pid, &iid).await?;

    let wf_ctx = WorkflowExecutionContext {
        project_id: pid.clone(),
        instance_id: iid.clone(),
        input: input_json.to_string(),
        steps,
        sleeps,
        promises,
        date_now: chrono::Utc::now().timestamp_millis(),
        handler_name: handler_name.map(|s| s.to_string()),
        handler_input: handler_input_json.map(|s| s.to_string()),
    };

    let redis_clone = redis.clone();
    let nats_clone = nats.clone();
    let source_owned = source.to_string();

    let result = tokio::task::spawn_blocking(move || {
        run_workflow_handler(&source_owned, &wf_ctx, &redis_clone, &nats_clone)
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))??;

    match &result {
        WorkflowExecutionResult::Completed(value) => {
            let result_key = redis_key(&pid, &iid, "result");
            let meta_key = redis_key(&pid, &iid, "meta");
            let mut conn = redis.lock().await;
            let _: () = conn
                .set(&result_key, value.as_str())
                .await
                .map_err(|e| e.to_string())?;

            if let Some(raw) = conn.get::<_, Option<String>>(&meta_key).await.map_err(|e| e.to_string())?
                && let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw)
            {
                meta.status = "completed".to_string();
                let updated = serde_json::to_string(&meta).unwrap_or_default();
                let _: () = conn
                    .set(&meta_key, &updated)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(value.clone())
        }
        WorkflowExecutionResult::Suspended {
            suspension_type,
            name,
            config,
        } => {
            // --- Host-side step retry ---
            if suspension_type == "step_retry" {
                let retry_key = redis_key(&pid, &iid, &format!("step_retry:{name}"));
                let retry_policy = config.get("retryPolicy").cloned().unwrap_or(serde_json::json!({}));
                let max_attempts = retry_policy.get("maxAttempts").and_then(|v| v.as_u64()).unwrap_or(3) as u32;

                let mut conn = redis.lock().await;
                let retry_state: Option<String> = conn.get(&retry_key).await.map_err(|e| e.to_string())?;
                let attempt = retry_state
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .and_then(|v| v.get("attempt").and_then(|a| a.as_u64()))
                    .unwrap_or(0) as u32
                    + 1;

                if attempt < max_attempts {
                    let init_ms = duration_to_ms(retry_policy.get("initialInterval")).unwrap_or(100.0);
                    let factor = retry_policy.get("backoffFactor").and_then(|v| v.as_f64()).unwrap_or(2.0);
                    let max_ms = duration_to_ms(retry_policy.get("maxInterval")).unwrap_or(60000.0);
                    let delay_ms = (init_ms * factor.powi((attempt - 1) as i32)).min(max_ms) as u64;

                    let retry_val = serde_json::json!({ "attempt": attempt }).to_string();
                    let _: () = conn.set(&retry_key, &retry_val).await.map_err(|e| e.to_string())?;

                    let meta_key = redis_key(&pid, &iid, "meta");
                    if let Some(raw) = conn.get::<_, Option<String>>(&meta_key).await.map_err(|e| e.to_string())?
                        && let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw)
                    {
                        meta.status = "suspended".to_string();
                        let updated = serde_json::to_string(&meta).unwrap_or_default();
                        let _: () = conn.set(&meta_key, &updated).await.map_err(|e| e.to_string())?;
                    }

                    let suspended_key = redis_key(&pid, &iid, "suspended");
                    let suspended_val = serde_json::json!({
                        "type": "step_retry",
                        "name": name,
                        "attempt": attempt,
                        "maxAttempts": max_attempts,
                        "delayMs": delay_ms,
                    }).to_string();
                    let _: () = conn.set(&suspended_key, &suspended_val).await.map_err(|e| e.to_string())?;
                    drop(conn);

                    if let Some(js_ctx) = js {
                        let subject = format!("wf.{pid}.{iid}.wake");
                        let fire_at = chrono::Utc::now().timestamp_millis() + delay_ms as i64;
                        let payload = serde_json::json!({
                            "reason": "step_retry",
                            "step": name,
                            "fire_at": fire_at,
                        }).to_string();
                        js_ctx
                            .publish(subject, bytes::Bytes::from(payload))
                            .await
                            .map_err(|e| format!("jetstream publish wake failed: {e}"))?;
                    }

                    return Ok(serde_json::json!({
                        "status": "suspended",
                        "suspensionType": "step_retry",
                        "name": name,
                        "attempt": attempt,
                        "maxAttempts": max_attempts,
                    }).to_string());
                } else {
                    // Retries exhausted — persist step failure so replay sees it
                    let error_msg = config.get("error").and_then(|v| v.as_str()).unwrap_or("step failed").to_string();
                    let step_key = redis_key(&pid, &iid, &format!("step:{name}"));
                    let step_val = serde_json::json!({
                        "status": "failed",
                        "error": error_msg,
                        "terminal": false,
                    }).to_string();
                    let _: () = conn.set(&step_key, &step_val).await.map_err(|e| e.to_string())?;
                    let _: () = conn.del(&retry_key).await.map_err(|e| e.to_string())?;
                    drop(conn);

                    // Immediately wake so the workflow replays and sees the cached failure
                    if let Some(nats_client) = nats {
                        let subject = format!("wf.{pid}.{iid}.wake");
                        let payload = serde_json::json!({
                            "reason": "step_retry_exhausted",
                            "step": name,
                        }).to_string();
                        let _ = nats_client
                            .publish(subject, bytes::Bytes::from(payload))
                            .await;
                    }

                    return Ok(serde_json::json!({
                        "status": "retry_exhausted",
                        "name": name,
                        "error": error_msg,
                    }).to_string());
                }
            }

            let meta_key = redis_key(&pid, &iid, "meta");
            let suspended_key = redis_key(&pid, &iid, "suspended");
            let suspended_val = serde_json::json!({
                "type": suspension_type,
                "name": name,
                "config": config,
            })
            .to_string();

            let mut conn = redis.lock().await;
            let _: () = conn
                .set(&suspended_key, &suspended_val)
                .await
                .map_err(|e| e.to_string())?;

            if let Some(raw) = conn.get::<_, Option<String>>(&meta_key).await.map_err(|e| e.to_string())?
                && let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw)
            {
                meta.status = "suspended".to_string();
                let updated = serde_json::to_string(&meta).unwrap_or_default();
                let _: () = conn
                    .set(&meta_key, &updated)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            drop(conn);

            // Schedule sleep wake via JetStream publish with fire_at
            if suspension_type == "sleep" {
                let duration_ms = config
                    .get("durationMs")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as u64;

                if let Some(js_ctx) = js {
                    let subject = format!("wf.{pid}.{iid}.wake");
                    let fire_at = chrono::Utc::now().timestamp_millis() + duration_ms as i64;
                    let payload = serde_json::json!({
                        "reason": "sleep_elapsed",
                        "sleep": name,
                        "fire_at": fire_at,
                    })
                    .to_string();
                    js_ctx
                        .publish(subject, bytes::Bytes::from(payload))
                        .await
                        .map_err(|e| format!("jetstream publish wake failed: {e}"))?;
                }
            }

            // Schedule promise timeout wake via JetStream publish with fire_at
            if suspension_type == "promise" {
                if let Some(timeout_ms) = config.get("timeout").and_then(|v| v.as_f64()) {
                    if timeout_ms >= 0.0 {
                        if let Some(js_ctx) = js {
                            let subject = format!("wf.{pid}.{iid}.wake");
                            let fire_at =
                                chrono::Utc::now().timestamp_millis() + timeout_ms as i64;
                            let payload = serde_json::json!({
                                "reason": "promise_timed_out",
                                "promise": name,
                                "fire_at": fire_at,
                            })
                            .to_string();
                            js_ctx
                                .publish(subject, bytes::Bytes::from(payload))
                                .await
                                .map_err(|e| format!("jetstream publish wake failed: {e}"))?;
                        }
                    }
                }
            }

            Ok(serde_json::json!({
                "status": "suspended",
                "suspensionType": suspension_type,
                "name": name,
            })
            .to_string())
        }
        WorkflowExecutionResult::Failed(error) => {
            let meta_key = redis_key(&pid, &iid, "meta");
            let result_key = redis_key(&pid, &iid, "result");
            let mut conn = redis.lock().await;

            let error_result = serde_json::json!({ "error": error }).to_string();
            let _: () = conn
                .set(&result_key, &error_result)
                .await
                .map_err(|e| e.to_string())?;

            if let Some(raw) = conn.get::<_, Option<String>>(&meta_key).await.map_err(|e| e.to_string())?
                && let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw)
            {
                meta.status = "failed".to_string();
                let updated = serde_json::to_string(&meta).unwrap_or_default();
                let _: () = conn
                    .set(&meta_key, &updated)
                    .await
                    .map_err(|e| e.to_string())?;
            }

            Err(error.clone())
        }
        WorkflowExecutionResult::HandlerResult(value) => {
            Ok(value.clone())
        }
    }
}

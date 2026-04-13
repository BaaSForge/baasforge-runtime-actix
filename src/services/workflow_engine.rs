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
    project_id: &str,
    unit_path: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
) -> Result<String, String> {
    let meta_key = redis_key(project_id, instance_id, "meta");

    // Deduplication: if meta already exists, return existing instance
    {
        let mut conn = redis.lock().await;
        let existing: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
        if existing.is_some() {
            return Ok(instance_id.to_string());
        }
    }

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
    }

    execute_workflow(redis, nats, project_id, instance_id, input_json, source, None, None).await?;

    Ok(instance_id.to_string())
}

/// Resume a workflow after a wake signal (timer or promise resolution).
pub async fn resume_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
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

    execute_workflow(redis, nats, project_id, instance_id, &meta.input, source, None, None).await?;
    Ok(())
}

/// Invoke a shared handler on a running workflow instance.
pub async fn call_handler(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    instance_id: &str,
    handler_name: &str,
    handler_input_json: &str,
    source: &str,
) -> Result<String, String> {
    execute_workflow(
        redis,
        nats,
        project_id,
        instance_id,
        "",
        source,
        Some(handler_name),
        Some(handler_input_json),
    )
    .await
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

    let mut conn = redis.lock().await;
    let meta_json: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
    let result_json: Option<String> = conn.get(&result_key).await.map_err(|e| e.to_string())?;

    let Some(meta_raw) = meta_json else {
        return Err("workflow instance not found".to_string());
    };

    let meta: serde_json::Value = serde_json::from_str(&meta_raw)
        .map_err(|e| format!("invalid meta: {e}"))?;

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
    project_id: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
    handler_name: Option<&str>,
    handler_input_json: Option<&str>,
) -> Result<String, String> {
    let (steps, sleeps, promises) = load_execution_context(redis, project_id, instance_id).await?;

    let wf_ctx = WorkflowExecutionContext {
        project_id: project_id.to_string(),
        instance_id: instance_id.to_string(),
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
    let pid = project_id.to_string();
    let iid = instance_id.to_string();

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
            let _: () = conn.set(&result_key, value.as_str()).await.map_err(|e| e.to_string())?;

            // Update meta status
            let meta_raw: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
            if let Some(raw) = meta_raw {
                if let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw) {
                    meta.status = "completed".to_string();
                    let updated = serde_json::to_string(&meta).unwrap_or_default();
                    let _: () = conn.set(&meta_key, &updated).await.map_err(|e| e.to_string())?;
                }
            }
            Ok(value.clone())
        }
        WorkflowExecutionResult::Suspended {
            suspension_type,
            name,
            config,
        } => {
            let meta_key = redis_key(&pid, &iid, "meta");
            let suspended_key = redis_key(&pid, &iid, "suspended");
            let suspended_val = serde_json::json!({
                "type": suspension_type,
                "name": name,
                "config": config,
            })
            .to_string();

            let mut conn = redis.lock().await;
            let _: () = conn.set(&suspended_key, &suspended_val).await.map_err(|e| e.to_string())?;

            // Update meta status to suspended
            let meta_raw: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
            if let Some(raw) = meta_raw {
                if let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw) {
                    meta.status = "suspended".to_string();
                    let updated = serde_json::to_string(&meta).unwrap_or_default();
                    let _: () = conn.set(&meta_key, &updated).await.map_err(|e| e.to_string())?;
                }
            }
            drop(conn);

            // Schedule wake signal for sleeps
            if suspension_type == "sleep" {
                if let Some(nats_client) = nats {
                    let duration_ms = config
                        .get("durationMs")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0) as u64;

                    let subject = format!("wf.{pid}.{iid}.wake");
                    let payload = serde_json::json!({
                        "reason": "sleep_elapsed",
                        "sleep": name,
                    })
                    .to_string();

                    let nats_client = nats_client.clone();
                    let subject_clone = subject.clone();
                    let payload_clone = payload.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(duration_ms)).await;
                        if let Err(e) = nats_client
                            .publish(subject_clone, bytes::Bytes::from(payload_clone))
                            .await
                        {
                            tracing::error!(
                                error = %e,
                                "failed to publish sleep wake signal"
                            );
                        }
                    });
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
            let _: () = conn.set(&result_key, &error_result).await.map_err(|e| e.to_string())?;

            let meta_raw: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
            if let Some(raw) = meta_raw {
                if let Ok(mut meta) = serde_json::from_str::<WorkflowMeta>(&raw) {
                    meta.status = "failed".to_string();
                    let updated = serde_json::to_string(&meta).unwrap_or_default();
                    let _: () = conn.set(&meta_key, &updated).await.map_err(|e| e.to_string())?;
                }
            }

            Err(error.clone())
        }
        WorkflowExecutionResult::HandlerResult(value) => {
            Ok(value.clone())
        }
    }
}

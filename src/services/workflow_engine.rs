use async_nats::jetstream;
use async_nats::jetstream::stream;
use opentelemetry::Context;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use uuid::Uuid;

use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::libs::unit_js::workflow_runner::{
    run_workflow_handler, WorkflowExecutionContext, WorkflowExecutionResult,
};

pub type SharedRedis = Arc<Mutex<redis::aio::MultiplexedConnection>>;

fn redis_key(project_id: &str, instance_id: &str, suffix: &str) -> String {
    format!("wf:{project_id}:{instance_id}:{suffix}")
}

fn workflow_dedup_name_key(project_id: &str, unit_path: &str, stage_runtime_id: Option<Uuid>) -> String {
    match stage_runtime_id {
        Some(rid) => format!("wf:{project_id}:name:stage:{rid}:{unit_path}"),
        None => format!("wf:{project_id}:name:{unit_path}"),
    }
}

fn workflow_start_inputs_equivalent(stored: &str, incoming: &str) -> bool {
    if stored == incoming {
        return true;
    }
    match (
        serde_json::from_str::<serde_json::Value>(stored),
        serde_json::from_str::<serde_json::Value>(incoming),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Get or create the durable JetStream stream that captures all workflow wake subjects.
/// The stream subject `wf.*.*.wake` matches every wake publish, including immediate
/// core-NATS publishes (promise resolved, retry exhausted) which are auto-captured.
pub async fn ensure_wf_wake_stream(
    client: &async_nats::Client,
    stream_name: &str,
) -> Result<jetstream::stream::Stream, String> {
    let js = jetstream::new(client.clone());
    js.create_or_update_stream(stream::Config {
        name: stream_name.to_string(),
        subjects: vec!["wf.*.*.wake".to_string(), "wf.*.*.start".to_string()],
        ..Default::default()
    })
    .await
    .map_err(|e| format!("JetStream stream setup failed: {e}"))?;
    js.get_stream(stream_name)
        .await
        .map_err(|e| format!("JetStream get_stream failed: {e}"))
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
    /// Instance ID of the workflow that called this one via sdk.callWorkflow.
    /// Set when callerTriggered is true. Used to resolve the caller's
    /// durable promise once this workflow completes or fails.
    #[serde(rename = "callerInstanceId", default)]
    pub caller_instance_id: Option<String>,
    /// The promise name in the caller's context to resolve/reject.
    /// Format: "sdk_call_N" where N is the call index.
    #[serde(rename = "callerPromiseName", default)]
    pub caller_promise_name: Option<String>,
    #[serde(rename = "stageRuntimeId", default, skip_serializing_if = "Option::is_none")]
    pub stage_runtime_id: Option<Uuid>,
}

/// Name-key resolution, optional resume, and Redis meta + `workflow.started` for a new instance.
/// Returns the instance id callers must use for `drive_workflow` / handler RPC (may differ from
/// `instance_id` when dedup returns an existing execution).
pub async fn prepare_workflow_instance_for_start(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    unit_path: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
    comm: Arc<SdkCommCtx>,
) -> Result<String, String> {
    let name_key = workflow_dedup_name_key(project_id, unit_path, comm.stage_runtime_id);
    {
        let mut conn = redis.lock().await;
        let claimed: bool = redis::cmd("SET")
            .arg(&name_key)
            .arg(instance_id)
            .arg("NX")
            .query_async(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;

        if !claimed {
            let existing_iid: Option<String> = conn.get(&name_key).await.map_err(|e| e.to_string())?;
            if let Some(eid) = existing_iid {
                let eid_meta_key = redis_key(project_id, &eid, "meta");
                let eid_meta: Option<String> =
                    conn.get(&eid_meta_key).await.map_err(|e| e.to_string())?;
                if let Some(raw) = eid_meta {
                    if let Ok(meta) = serde_json::from_str::<WorkflowMeta>(&raw) {
                        if meta.status == "suspended" {
                            drop(conn);
                            let _ = resume_workflow(redis, nats, js, project_id, &eid, source, comm.clone()).await;
                            return Ok(eid);
                        }
                        if meta.status == "running" {
                            let lock_key = format!("wf:{project_id}:{eid}:exec_lock");
                            let lock_exists: bool = redis::cmd("EXISTS")
                                .arg(&lock_key)
                                .query_async(&mut *conn)
                                .await
                                .unwrap_or(false);
                            if lock_exists && workflow_start_inputs_equivalent(&meta.input, input_json) {
                                drop(conn);
                                return Ok(eid);
                            }
                        }
                    }
                }
                let _: () =
                    conn.set(&name_key, instance_id).await.map_err(|e| e.to_string())?;
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
        caller_instance_id: None,
        caller_promise_name: None,
        stage_runtime_id: comm.stage_runtime_id,
    };
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;

    {
        let mut conn = redis.lock().await;
        let _: () = conn.set(&meta_key, &meta_json).await.map_err(|e| e.to_string())?;
    }

    publish_wf_event(
        nats,
        project_id,
        instance_id,
        "workflow.started",
        unit_path,
        serde_json::json!({ "input": input_json }),
        comm.stage_runtime_id,
    )
    .await;

    Ok(instance_id.to_string())
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
    comm: Arc<SdkCommCtx>,
) -> Result<String, String> {
    let effective_id =
        prepare_workflow_instance_for_start(redis, nats, js, project_id, unit_path, instance_id, input_json, source, comm.clone()).await?;
    if effective_id == instance_id {
        let _ = drive_workflow(redis, nats, js, project_id, instance_id, input_json, source, None, None, comm).await;
    }
    Ok(effective_id)
}

/// Resume a workflow after a wake signal (timer or promise resolution).
pub async fn resume_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    instance_id: &str,
    source: &str,
    comm: Arc<SdkCommCtx>,
) -> Result<(), String> {
    let meta_key = redis_key(project_id, instance_id, "meta");
    let old_meta = {
        let mut conn = redis.lock().await;
        match transition_status(&mut conn, &meta_key, &["suspended", "running"], "running").await? {
            StatusTransition::Done(meta) => meta,
            _ => return Ok(()),
        }
    };
    drive_workflow(redis, nats, js, project_id, instance_id, &old_meta.input, source, None, None, comm)
        .await?;
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
    comm: Arc<SdkCommCtx>,
) -> Result<String, String> {
    {
        let meta_key = redis_key(project_id, instance_id, "meta");
        let mut conn = redis.lock().await;
        let meta: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
        if meta.is_none() {
            return Err("workflow instance not found".to_string());
        }
    }

    let handler_result = drive_workflow(
        redis,
        nats,
        js,
        project_id,
        instance_id,
        "",
        source,
        Some(handler_name),
        Some(handler_input_json),
        comm.clone(),
    )
    .await?;

    let _ = resume_workflow(redis, nats, js, project_id, instance_id, source, comm).await;

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
    match transition_status(&mut conn, &meta_key, &["running", "suspended"], "cancelled").await? {
        StatusTransition::NotFound => Err("workflow instance not found".to_string()),
        StatusTransition::Rejected { current } => Err(format!("workflow already {current}")),
        StatusTransition::Done(_) => Ok(()),
    }
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

/// Get the final result of a completed workflow.
/// Returns `Ok(None)` if the instance exists but has not completed yet.
/// Returns `Err` containing "not found" if the instance does not exist.
pub async fn get_workflow_result(
    redis: &SharedRedis,
    project_id: &str,
    instance_id: &str,
) -> Result<Option<String>, String> {
    let meta_key = redis_key(project_id, instance_id, "meta");
    let result_key = redis_key(project_id, instance_id, "result");
    let mut conn = redis.lock().await;
    let meta: Option<String> = conn.get(&meta_key).await.map_err(|e| e.to_string())?;
    if meta.is_none() {
        return Err("workflow instance not found".to_string());
    }
    conn.get(&result_key).await.map_err(|e| e.to_string())
}

/// Resolve a durable promise from outside (e.g., from a route handler).
pub async fn resolve_promise(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
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

    let set_ok: bool = {
        let mut conn = redis.lock().await;
        redis::cmd("SET")
            .arg(&rkey)
            .arg(&value)
            .arg("NX")
            .query_async(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
    };
    if !set_ok {
        return Ok(());
    }

    let subject = format!("wf.{project_id}.{instance_id}.wake");
    let mut wake = serde_json::json!({
        "reason": "promise_resolved",
        "promise": promise_name,
    });
    if let Some(obj) = wake.as_object_mut() {
        crate::telemetry::inject_traceparent_json_field(obj);
    }
    let payload = wake.to_string();
    if let Some(js_ctx) = js {
        js_ctx
            .publish(subject, bytes::Bytes::from(payload))
            .await
            .map_err(|e| format!("jetstream publish wake failed: {e}"))?;
    } else if let Some(nats_client) = nats {
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

/// Publish a lifecycle event to core NATS for real-time broadcasting.
/// Subject: `wf.events.{project_id}.workflow.{instance_id}`
/// Non-fatal: publish errors are logged, not propagated.
async fn publish_wf_event(
    nats: &Option<async_nats::Client>,
    project_id: &str,
    instance_id: &str,
    event_type: &str,
    unit_path: &str,
    extra: serde_json::Value,
    stage_runtime_id: Option<Uuid>,
) {
    let Some(nats_client) = nats else { return };
    let subject = format!("wf.events.{project_id}.workflow.{instance_id}");
    let mut payload = serde_json::json!({
        "event": event_type,
        "projectId": project_id,
        "instanceId": instance_id,
        "unitPath": unit_path,
        "timestamp": chrono::Utc::now().to_rfc3339(),
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
        tracing::warn!(error = %e, "publish_wf_event failed");
    }
}

// -- Internal helpers --

fn wake_jetstream_payload(body: serde_json::Value) -> String {
    let mut v = body;
    if let Some(obj) = v.as_object_mut() {
        crate::telemetry::inject_traceparent_json_field(obj);
    }
    v.to_string()
}

fn wake_jetstream_payload_in_trace_carrier(body: serde_json::Value, carrier: &Context) -> String {
    let _g = carrier.clone().attach();
    wake_jetstream_payload(body)
}

/// Resolve the caller workflow's durable promise after a callee completes.
/// Writes the promise state to Redis then publishes a wake signal to the caller.
async fn resolve_caller_promise(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    caller_instance_id: &str,
    promise_name: &str,
    value_json: &str,
) {
    if let Err(e) =
        resolve_promise(redis, nats, js, project_id, caller_instance_id, promise_name, value_json).await
    {
        tracing::warn!(
            caller_iid = %caller_instance_id,
            promise = %promise_name,
            error = %e,
            "resolve_caller_promise failed — caller may time out"
        );
    }
}

/// Reject the caller workflow's durable promise after a callee fails.
pub(crate) async fn reject_caller_promise(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    caller_instance_id: &str,
    promise_name: &str,
    error: &str,
) {
    let rkey = redis_key(project_id, caller_instance_id, &format!("promise:{promise_name}"));
    let value = serde_json::json!({ "status": "rejected", "error": error }).to_string();

    let set_ok: bool = {
        let mut conn = redis.lock().await;
        match redis::cmd("SET")
            .arg(&rkey)
            .arg(&value)
            .arg("NX")
            .query_async(&mut *conn)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "reject_caller_promise: redis SET NX failed");
                return;
            }
        }
    };
    if !set_ok {
        return;
    }

    let subject = format!("wf.{project_id}.{caller_instance_id}.wake");
    let mut wake = serde_json::json!({
        "reason": "promise_rejected",
        "promise": promise_name,
    });
    if let Some(obj) = wake.as_object_mut() {
        crate::telemetry::inject_traceparent_json_field(obj);
    }
    let payload = wake.to_string();
    if let Some(js_ctx) = js {
        if let Err(e) = js_ctx.publish(subject, bytes::Bytes::from(payload)).await {
            tracing::warn!(error = %e, "reject_caller_promise: jetstream publish failed");
        }
    } else if let Some(nats_client) = nats {
        if let Err(e) = nats_client.publish(subject, bytes::Bytes::from(payload)).await {
            tracing::warn!(error = %e, "reject_caller_promise: nats publish failed");
        }
    }
}

const TRANSITION_STATUS_LUA: &str = r#"
local meta_raw = redis.call('GET', KEYS[1])
if not meta_raw then return nil end
local meta = cjson.decode(meta_raw)
local current = meta.status
local allowed = cjson.decode(ARGV[1])
for _, s in ipairs(allowed) do
    if current == s then
        meta.status = ARGV[2]
        redis.call('SET', KEYS[1], cjson.encode(meta))
        return meta_raw
    end
end
return cjson.encode({rejected = current})
"#;

enum StatusTransition {
    Done(WorkflowMeta),
    NotFound,
    Rejected { current: String },
}

async fn transition_status(
    conn: &mut redis::aio::MultiplexedConnection,
    meta_key: &str,
    allowed_from: &[&str],
    new_status: &str,
) -> Result<StatusTransition, String> {
    let allowed_json = serde_json::to_string(allowed_from).map_err(|e| e.to_string())?;
    let result: Option<String> = redis::Script::new(TRANSITION_STATUS_LUA)
        .key(meta_key)
        .arg(&allowed_json)
        .arg(new_status)
        .invoke_async(conn)
        .await
        .map_err(|e| format!("lua transition_status: {e}"))?;

    let Some(raw) = result else {
        return Ok(StatusTransition::NotFound);
    };

    let val: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse transition result: {e}"))?;
    if let Some(current) = val.get("rejected").and_then(|v| v.as_str()) {
        return Ok(StatusTransition::Rejected { current: current.to_string() });
    }

    let meta: WorkflowMeta =
        serde_json::from_str(&raw).map_err(|e| format!("parse old meta: {e}"))?;
    Ok(StatusTransition::Done(meta))
}

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

pub async fn launch_callee_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
    unit_path: &str,
    comm: Arc<SdkCommCtx>,
) -> Result<(), String> {
    let meta_key = redis_key(project_id, instance_id, "meta");
    let meta_json: String = {
        let mut conn = redis.lock().await;
        conn.get(&meta_key).await.map_err(|e| e.to_string())?
    };
    let mut meta: WorkflowMeta = serde_json::from_str(&meta_json)
        .map_err(|e| format!("invalid callee meta: {e}"))?;

    if meta.status != "pending" {
        return Ok(());
    }

    meta.status = "running".to_string();
    let updated_meta = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let name_key = workflow_dedup_name_key(project_id, unit_path, meta.stage_runtime_id);
    {
        let mut conn = redis.lock().await;
        let _: () = conn.set(&meta_key, &updated_meta).await.map_err(|e| e.to_string())?;
        let _: () = conn.set(&name_key, instance_id).await.map_err(|e| e.to_string())?;
    }

    publish_wf_event(
        nats,
        project_id,
        instance_id,
        "workflow.started",
        unit_path,
        serde_json::json!({ "input": input_json }),
        meta.stage_runtime_id,
    )
    .await;
    drive_workflow(redis, nats, js, project_id, instance_id, input_json, source, None, None, comm).await?;
    Ok(())
}

pub(crate) async fn drive_workflow(
    redis: &SharedRedis,
    nats: &Option<async_nats::Client>,
    js: &Option<jetstream::Context>,
    project_id: &str,
    instance_id: &str,
    input_json: &str,
    source: &str,
    handler_name: Option<&str>,
    handler_input_json: Option<&str>,
    comm: Arc<SdkCommCtx>,
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
    let comm_for_spawn = comm.for_unit(pid.clone(), String::new(), Some(iid.clone()));
    let rid = comm_for_spawn.stage_runtime_id.map(|u| u.to_string());
    let trigger_runtime = if comm_for_spawn.stage_runtime_id.is_some() {
        Some("stage")
    } else {
        Some("production")
    };
    let parent_ctx = crate::telemetry::context_with_telemetry_baggage(
        tracing::Span::current().context(),
        Some(comm_for_spawn.project_id.as_str()),
        trigger_runtime,
        rid.as_deref(),
    );
    drop(parent_ctx.clone().attach());

    let result = run_workflow_handler(&source_owned, &wf_ctx, &redis_clone, &nats_clone, comm_for_spawn)
        .await?;

    match &result {
        WorkflowExecutionResult::Completed(value) => {
            let result_key = redis_key(&pid, &iid, "result");
            let meta_key = redis_key(&pid, &iid, "meta");
            let mut conn = redis.lock().await;

            let (unit_path, caller_iid, caller_promise) =
                match transition_status(&mut conn, &meta_key, &["running"], "completed").await? {
                    StatusTransition::Done(old_meta) => {
                        let _: () = conn
                            .set(&result_key, value.as_str())
                            .await
                            .map_err(|e| e.to_string())?;
                        let ciid = old_meta
                            .caller_triggered
                            .then(|| old_meta.caller_instance_id.clone())
                            .flatten();
                        let cpromise = old_meta
                            .caller_triggered
                            .then(|| old_meta.caller_promise_name.clone())
                            .flatten();
                        (old_meta.name.clone(), ciid, cpromise)
                    }
                    _ => {
                        drop(conn);
                        return Ok(value.clone());
                    }
                };
            drop(conn);

            publish_wf_event(
                nats,
                &pid,
                &iid,
                "workflow.completed",
                &unit_path,
                serde_json::json!({ "result": value }),
                comm.stage_runtime_id,
            )
            .await;

            if let (Some(ref ciid), Some(ref cpromise)) = (caller_iid, caller_promise) {
                resolve_caller_promise(redis, nats, js, &pid, ciid, cpromise, value).await;
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
                    let _ =
                        transition_status(&mut conn, &meta_key, &["running"], "suspended").await;

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
                        let payload = wake_jetstream_payload_in_trace_carrier(
                            serde_json::json!({
                            "reason": "step_retry",
                            "step": name,
                            "fire_at": fire_at,
                            }),
                            &parent_ctx,
                        );
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

                    let meta_key = redis_key(&pid, &iid, "meta");
                    let _ = transition_status(&mut conn, &meta_key, &["running"], "suspended").await;
                    drop(conn);

                    // Wake via JetStream so replay is durable even if the worker restarts
                    if let Some(js_ctx) = js {
                        let subject = format!("wf.{pid}.{iid}.wake");
                        let payload = wake_jetstream_payload_in_trace_carrier(
                            serde_json::json!({
                            "reason": "step_retry_exhausted",
                            "step": name,
                            }),
                            &parent_ctx,
                        );
                        let _ = js_ctx.publish(subject, bytes::Bytes::from(payload)).await;
                    } else if let Some(nats_client) = nats {
                        let subject = format!("wf.{pid}.{iid}.wake");
                        let payload = wake_jetstream_payload_in_trace_carrier(
                            serde_json::json!({
                            "reason": "step_retry_exhausted",
                            "step": name,
                            }),
                            &parent_ctx,
                        );
                        let _ = nats_client.publish(subject, bytes::Bytes::from(payload)).await;
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

            let unit_path = match transition_status(&mut conn, &meta_key, &["running"], "suspended")
                .await?
            {
                StatusTransition::Done(old_meta) => old_meta.name.clone(),
                _ => String::new(),
            };
            drop(conn);

            publish_wf_event(
                nats,
                &pid,
                &iid,
                "workflow.suspended",
                &unit_path,
                serde_json::json!({ "suspensionType": suspension_type, "name": name }),
                comm.stage_runtime_id,
            )
            .await;

            // Schedule sleep wake via JetStream publish with fire_at
            if suspension_type == "sleep" {
                let duration_ms = config
                    .get("durationMs")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as u64;

                if let Some(js_ctx) = js {
                    let subject = format!("wf.{pid}.{iid}.wake");
                    let fire_at = chrono::Utc::now().timestamp_millis() + duration_ms as i64;
                    let payload = wake_jetstream_payload_in_trace_carrier(
                        serde_json::json!({
                        "reason": "sleep_elapsed",
                        "sleep": name,
                        "fire_at": fire_at,
                        }),
                        &parent_ctx,
                    );
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
                            let payload = wake_jetstream_payload_in_trace_carrier(
                                serde_json::json!({
                                "reason": "promise_timed_out",
                                "promise": name,
                                "fire_at": fire_at,
                                }),
                                &parent_ctx,
                            );
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

            let (unit_path, caller_iid, caller_promise) =
                match transition_status(&mut conn, &meta_key, &["running"], "failed").await? {
                    StatusTransition::Done(old_meta) => {
                        let error_result = serde_json::json!({ "error": error }).to_string();
                        let _: () = conn
                            .set(&result_key, &error_result)
                            .await
                            .map_err(|e| e.to_string())?;
                        let ciid = old_meta
                            .caller_triggered
                            .then(|| old_meta.caller_instance_id.clone())
                            .flatten();
                        let cpromise = old_meta
                            .caller_triggered
                            .then(|| old_meta.caller_promise_name.clone())
                            .flatten();
                        (old_meta.name.clone(), ciid, cpromise)
                    }
                    _ => {
                        drop(conn);
                        return Err(error.clone());
                    }
                };
            drop(conn);

            publish_wf_event(
                nats,
                &pid,
                &iid,
                "workflow.failed",
                &unit_path,
                serde_json::json!({ "error": error }),
                comm.stage_runtime_id,
            )
            .await;

            if let (Some(ref ciid), Some(ref cpromise)) = (caller_iid, caller_promise) {
                reject_caller_promise(redis, nats, js, &pid, ciid, cpromise, error).await;
            }

            Err(error.clone())
        }
        WorkflowExecutionResult::HandlerResult(value) => {
            Ok(value.clone())
        }
    }
}

use async_nats::jetstream;
use futures::StreamExt;
use opentelemetry::trace::{FutureExt, TraceContextExt};
use rquickjs::{Ctx, Exception, Value, function::Func};
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::database::{DbPool, SharedRedisConn};
use crate::models::actor_store::ActorPgPool;
use uuid::Uuid;

pub type SharedRedis = Arc<Mutex<redis::aio::MultiplexedConnection>>;
pub type SdkActorLocks =
    Arc<Mutex<HashMap<(String, String, String, Option<Uuid>), Arc<Mutex<()>>>>>;

/// All connections + call-site metadata needed by the `__baal_*` host functions.
///
/// Constructed per-call (runner sets `project_id` / `source_unit_path` before eval)
/// and stored in `COMM_CTX` thread-local so the host functions can access it without
/// threading extra params through the QuickJS call stack.
#[derive(Clone)]
pub struct SdkCommCtx {
    pub pool: DbPool,
    pub redis_conn: SharedRedisConn,
    pub wf_redis: Option<SharedRedis>,
    pub wq_redis: Option<SharedRedis>,
    pub actor_redis: Option<SharedRedis>,
    pub wf_nats: Option<async_nats::Client>,
    pub wf_js: Option<jetstream::Context>,
    pub wq_nats: Option<async_nats::Client>,
    pub wq_js: Option<jetstream::Context>,
    pub actor_nats: Option<async_nats::Client>,
    pub actor_js: Option<jetstream::Context>,
    pub actor_pg: Option<ActorPgPool>,
    pub actor_locks: SdkActorLocks,
    pub project_id: String,
    pub source_unit_path: String,
    pub source_instance_id: Option<String>,
    pub stage_runtime_id: Option<Uuid>,
    /// Prod or stage runtime row id for this invocation (used by `getSecureEnv` cache keys).
    pub resolved_runtime_id: Option<Uuid>,
    pub sdk_public_host: String,
    pub sdk_trigger_base_path: String,
}

impl SdkCommCtx {
    pub fn for_unit(&self, project_id: String, unit_path: String, instance_id: Option<String>) -> Arc<Self> {
        Arc::new(SdkCommCtx {
            project_id,
            source_unit_path: unit_path,
            source_instance_id: instance_id,
            ..self.clone()
        })
    }

    pub fn with_stage_runtime(&self, stage_runtime_id: Option<Uuid>) -> Arc<Self> {
        Arc::new(SdkCommCtx {
            resolved_runtime_id: stage_runtime_id.or(self.resolved_runtime_id),
            stage_runtime_id,
            ..self.clone()
        })
    }
}

thread_local! {
    static COMM_CTX: RefCell<Option<Arc<SdkCommCtx>>> = const { RefCell::new(None) };
}

pub fn set_comm_ctx(ctx: Arc<SdkCommCtx>) {
    COMM_CTX.with(|c| *c.borrow_mut() = Some(ctx));
}

pub fn clear_comm_ctx() {
    COMM_CTX.with(|c| *c.borrow_mut() = None);
}

pub fn get_project_id() -> Option<String> {
    COMM_CTX.with(|c| c.borrow().as_ref().map(|ctx| ctx.project_id.clone()))
}

fn with_comm_ctx<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(Arc<SdkCommCtx>) -> Result<R, String>,
{
    let comm = COMM_CTX.with(|c| c.borrow().clone());
    match comm {
        Some(ctx) => f(ctx),
        None => Err("SdkCommCtx not available — not inside a unit runtime".to_string()),
    }
}

// ---------------------------------------------------------------------------
// WorkflowHostCtx — unchanged from before, keeps the per-workflow durable
// persistence host functions (__baal_persist_step, __baal_start_call, etc.)
// ---------------------------------------------------------------------------

pub struct WorkflowHostCtx {
    pub(in crate::libs::unit_js) redis: Arc<Mutex<redis::aio::MultiplexedConnection>>,
    pub(in crate::libs::unit_js) nats: Option<async_nats::Client>,
    pub(in crate::libs::unit_js) project_id: String,
    pub(in crate::libs::unit_js) instance_id: String,
}

std::thread_local! {
    static HOST_CTX: RefCell<Option<Arc<WorkflowHostCtx>>> = const { RefCell::new(None) };
}

pub fn set_host_ctx(ctx: Arc<WorkflowHostCtx>) {
    HOST_CTX.with(|c| *c.borrow_mut() = Some(ctx));
}

pub fn clear_host_ctx() {
    HOST_CTX.with(|c| *c.borrow_mut() = None);
}

fn with_host_ctx<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&WorkflowHostCtx) -> Result<R, String>,
{
    HOST_CTX.with(|c| {
        let borrow = c.borrow();
        match borrow.as_ref() {
            Some(ctx) => f(ctx),
            None => Err("workflow host context not available".to_string()),
        }
    })
}

fn block_async<F, R>(future: F) -> Result<R, String>
where
    F: std::future::Future<Output = Result<R, String>> + Send,
{
    let cx = tracing::Span::current().context();
    tokio::runtime::Handle::current().block_on(future.with_context(cx))
}

const MAX_SDK_TRACE_CHARS: usize = 8192;

fn sdk_trace_preview(s: &str) -> String {
    if s.chars().count() <= MAX_SDK_TRACE_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_SDK_TRACE_CHARS).collect();
    out.push_str("…(truncated for trace)");
    out
}

fn sdk_json_preview(v: &serde_json::Value) -> String {
    sdk_trace_preview(&v.to_string())
}

macro_rules! sdk_span {
    ($op:literal) => {{
        let unit_path = COMM_CTX.with(|c| {
            c.borrow()
                .as_ref()
                .map(|x| x.source_unit_path.clone())
                .unwrap_or_default()
        });
        let project_id = COMM_CTX.with(|c| {
            c.borrow()
                .as_ref()
                .map(|x| x.project_id.clone())
                .unwrap_or_default()
        });
        let env_label: &'static str = COMM_CTX.with(|c| {
            match c.borrow().as_ref() {
                Some(x) if x.stage_runtime_id.is_some() => "stage",
                _ => "production",
            }
        });
        let parent_cx = tracing::Span::current().context();
        let parent_sc = parent_cx.span().span_context().clone();
        let span = tracing::info_span!(
            $op,
            baal.operation = $op,
            baal.caller_unit_path = %unit_path,
            baal.project.id = %project_id,
            baal.app.environment = env_label,
            baal.runtime.id = tracing::field::Empty,
            baal.release.id = tracing::field::Empty,
            baal.correlation.trace_id = tracing::field::Empty,
            baal.sdk.input = tracing::field::Empty,
            baal.sdk.output = tracing::field::Empty,
        );
        if parent_sc.is_valid() {
            let tid = format!("{}", parent_sc.trace_id());
            span.set_parent(parent_cx);
            span.record("baal.correlation.trace_id", tid.as_str());
        }
        span
    }};
}

fn sdk_record_release_and_runtime_ids(span: &tracing::Span, comm: &SdkCommCtx) {
    let Ok(pu) = Uuid::parse_str(comm.project_id.as_str()) else {
        return;
    };
    let pool = comm.pool.clone();
    let redis = comm.redis_conn.clone();
    let stage = comm.stage_runtime_id;
    let Ok((release, runtime)) = block_async(async move {
        let release = crate::services::project_release::load_live_release_id_scoped(
            &pool, &redis, pu, stage,
        )
        .await
        .ok()
        .flatten()
        .map(|u| u.to_string());
        let runtime = match stage {
            Some(rid) => Some(rid.to_string()),
            None => crate::services::project_release::load_production_runtime_id_for_project(
                &pool, pu,
            )
            .await
            .ok()
            .flatten()
            .map(|u| u.to_string()),
        };
        Ok::<_, String>((release, runtime))
    }) else {
        return;
    };
    if let Some(ref r) = release {
        span.record("baal.release.id", r.as_str());
    }
    if let Some(ref r) = runtime {
        span.record("baal.runtime.id", r.as_str());
    }
}

fn record_sdk_input(span: &tracing::Span, v: &serde_json::Value) {
    span.record("baal.sdk.input", sdk_json_preview(v).as_str());
}

fn record_sdk_output_json(span: &tracing::Span, v: &serde_json::Value) {
    span.record("baal.sdk.output", sdk_json_preview(v).as_str());
}

fn record_sdk_output_result_str(span: &tracing::Span, res: &Result<String, String>) {
    let v = match res {
        Ok(s) => serde_json::json!({ "ok": true, "returned": serde_json::from_str::<serde_json::Value>(s).unwrap_or(serde_json::Value::String(s.clone())) }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    record_sdk_output_json(span, &v);
}

fn json_payload_field(payload_json: &str) -> serde_json::Value {
    serde_json::from_str(payload_json).unwrap_or_else(|_| serde_json::Value::String(payload_json.to_owned()))
}

fn compute_api_unit_trigger_url(comm: &SdkCommCtx, unit_path_or_id: &str) -> Result<String, String> {
    let project_id = comm.project_id.as_str();
    if project_id.is_empty() {
        return Err("sdk.getApiUnitTriggerUrl: project id not available".to_string());
    }
    let mut parts: Vec<&str> = unit_path_or_id.split('.').collect();
    if parts.len() == 5 {
        let rev: i64 = parts[4]
            .parse()
            .map_err(|_| "sdk.getApiUnitTriggerUrl: invalid revision in unit id".to_string())?;
        if rev < 1 {
            return Err("sdk.getApiUnitTriggerUrl: invalid revision in unit id".to_string());
        }
        parts.truncate(4);
    }
    if parts.len() != 4 {
        return Err("sdk.getApiUnitTriggerUrl: expected 4-segment unit path or 5-segment unit id".to_string());
    }
    if parts[2] != "api" {
        return Err(format!(
            "sdk.getApiUnitTriggerUrl: unit type \"{}\" is not an API unit",
            parts[2]
        ));
    }
    let host = comm.sdk_public_host.as_str();
    let stage_segments: Vec<&str> = comm.sdk_trigger_base_path.split('/').collect();
    let is_stage = stage_segments.contains(&"stage");
    let path_tail = format!("{}/{}/{}", parts[0], parts[1], parts[3]);
    if is_stage {
        let stage_idx = stage_segments
            .iter()
            .position(|s| *s == "stage")
            .unwrap_or(0);
        let runtime_id = stage_segments.get(stage_idx + 1).copied().unwrap_or("");
        if runtime_id.is_empty() {
            return Err("sdk.getApiUnitTriggerUrl: stage runtime id not found in trigger path".to_string());
        }
        Ok(format!(
            "http://{host}/api/v1/trigger/{project_id}/stage/{runtime_id}/{path_tail}"
        ))
    } else {
        Ok(format!("http://{host}/api/v1/trigger/{project_id}/{path_tail}"))
    }
}

fn redis_key(project_id: &str, instance_id: &str, suffix: &str) -> String {
    format!("wf:{project_id}:{instance_id}:{suffix}")
}

// ---------------------------------------------------------------------------
// Workflow persistence host functions (register_workflow_persistence)
// ---------------------------------------------------------------------------

pub fn register_workflow_persistence(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals().set("__baal_persist_step", Func::from(host_persist_step))?;
    ctx.globals().set("__baal_persist_step_error", Func::from(host_persist_step_error))?;
    ctx.globals().set("__baal_persist_sleep", Func::from(host_persist_sleep))?;
    ctx.globals().set("__baal_persist_state", Func::from(host_persist_state))?;
    ctx.globals().set("__baal_read_state", Func::from(host_read_state))?;
    ctx.globals().set("__baal_resolve_promise", Func::from(host_resolve_promise))?;
    ctx.globals().set("__baal_reject_promise", Func::from(host_reject_promise))?;
    ctx.globals().set("__baal_start_call", Func::from(host_start_call))?;
    Ok(())
}

fn host_persist_step(ctx: Ctx<'_>, name: String, result_json: String, _opts_json: String) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
        block_async(async {
            let key = redis_key(&hctx.project_id, &hctx.instance_id, &format!("step:{name}"));
            let value = serde_json::json!({ "status": "completed", "result": result_json }).to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET").arg(&key).arg(&value).query_async::<()>(&mut *conn).await
                .map_err(|e| format!("redis SET step failed: {e}"))
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_persist_step_error(ctx: Ctx<'_>, name: String, error_msg: String, is_terminal: bool, _opts_json: String) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
        block_async(async {
            let key = redis_key(&hctx.project_id, &hctx.instance_id, &format!("step:{name}"));
            let value = serde_json::json!({ "status": "failed", "error": error_msg, "terminal": is_terminal }).to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET").arg(&key).arg(&value).query_async::<()>(&mut *conn).await
                .map_err(|e| format!("redis SET step error failed: {e}"))
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_persist_sleep(ctx: Ctx<'_>, name: String, _duration_ms: f64) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
        block_async(async {
            let key = redis_key(&hctx.project_id, &hctx.instance_id, &format!("sleep:{name}"));
            let value = serde_json::json!({ "elapsed": true }).to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET").arg(&key).arg(&value).query_async::<()>(&mut *conn).await
                .map_err(|e| format!("redis SET sleep failed: {e}"))
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_persist_state(ctx: Ctx<'_>, key: String, value_json: String) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
        block_async(async {
            let rkey = redis_key(&hctx.project_id, &hctx.instance_id, &format!("state:{key}"));
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET").arg(&rkey).arg(&value_json).query_async::<()>(&mut *conn).await
                .map_err(|e| format!("redis SET state failed: {e}"))
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_read_state<'js>(ctx: Ctx<'js>, key: String) -> rquickjs::Result<Value<'js>> {
    let res: Result<Option<String>, String> = with_host_ctx(|hctx| {
        block_async(async {
            let rkey = redis_key(&hctx.project_id, &hctx.instance_id, &format!("state:{key}"));
            let mut conn = hctx.redis.lock().await;
            redis::cmd("GET").arg(&rkey).query_async::<Option<String>>(&mut *conn).await
                .map_err(|e| format!("redis GET state failed: {e}"))
        })
    });
    match res {
        Ok(Some(v)) => rquickjs::String::from_str(ctx.clone(), &v).map(|s| s.into_value()),
        Ok(None) => Ok(Value::new_null(ctx)),
        Err(e) => Err(Exception::throw_message(&ctx, &e)),
    }
}

fn host_resolve_promise(ctx: Ctx<'_>, name: String, value_json: String) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        let instance_id = hctx.instance_id.clone();
        block_async(async {
            let rkey = redis_key(&project_id, &instance_id, &format!("promise:{name}"));
            let value = serde_json::json!({ "status": "resolved", "value": value_json }).to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET").arg(&rkey).arg(&value).query_async::<()>(&mut *conn).await
                .map_err(|e| format!("redis SET promise failed: {e}"))?;
            if let Some(nats) = &hctx.nats {
                let subject = format!("wf.{project_id}.{instance_id}.wake");
                let mut wake = serde_json::json!({ "reason": "promise_resolved", "promise": name });
                if let Some(obj) = wake.as_object_mut() {
                    crate::telemetry::inject_traceparent_json_field(obj);
                }
                nats.publish(subject, bytes::Bytes::from(wake.to_string())).await
                    .map_err(|e| format!("nats publish wake failed: {e}"))?;
            }
            Ok(())
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_reject_promise(ctx: Ctx<'_>, name: String, error: String) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        let instance_id = hctx.instance_id.clone();
        block_async(async {
            let rkey = redis_key(&project_id, &instance_id, &format!("promise:{name}"));
            let value = serde_json::json!({ "status": "rejected", "error": error }).to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET").arg(&rkey).arg(&value).query_async::<()>(&mut *conn).await
                .map_err(|e| format!("redis SET promise reject failed: {e}"))?;
            if let Some(nats) = &hctx.nats {
                let subject = format!("wf.{project_id}.{instance_id}.wake");
                let mut wake = serde_json::json!({ "reason": "promise_rejected", "promise": name });
                if let Some(obj) = wake.as_object_mut() {
                    crate::telemetry::inject_traceparent_json_field(obj);
                }
                let payload = wake.to_string();
                nats.publish(subject, bytes::Bytes::from(payload)).await
                    .map_err(|e| format!("nats publish wake failed: {e}"))?;
            }
            Ok(())
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_start_call(ctx: Ctx<'_>, unit_path: String, data_json: String, promise_name: String) -> rquickjs::Result<()> {
    let span = sdk_span!("workflow.durable.startChildWorkflow");
    let _g = span.enter();
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "input": json_payload_field(&data_json),
        "promiseName": &promise_name,
    });
    record_sdk_input(&span, &input);
    let res: Result<(), String> = with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        let caller_instance_id = hctx.instance_id.clone();
        let stage_runtime_id = COMM_CTX.with(|c| c.borrow().as_ref().and_then(|co| co.stage_runtime_id));
        block_async(async {
            let parts: Vec<&str> = unit_path.split('.').collect();
            if parts.len() != 4 {
                return Err(format!("sdk.callWorkflow: invalid unit path '{unit_path}' — expected context.module.unitType.name"));
            }
            if parts[2] != "workflow" {
                let label = if parts[2] == "api" { "API unit" } else { parts[2] };
                return Err(format!("sdk.callWorkflow: target is an {label}, not a workflow unit"));
            }

            let callee_instance_id = crate::libs::ids::new_uuid().to_string();
            let meta_key = redis_key(&project_id, &callee_instance_id, "meta");
            let mut meta_val = serde_json::json!({
                "name": unit_path,
                "status": "pending",
                "input": data_json,
                "createdAt": chrono::Utc::now().to_rfc3339(),
                "callerTriggered": true,
                "callerInstanceId": caller_instance_id,
                "callerPromiseName": promise_name,
            });
            if let Some(rid) = stage_runtime_id {
                meta_val["stageRuntimeId"] = serde_json::json!(rid);
            }
            let meta = meta_val.to_string();
            {
                let mut conn = hctx.redis.lock().await;
                redis::cmd("SET").arg(&meta_key).arg(&meta).query_async::<()>(&mut *conn).await
                    .map_err(|e| format!("sdk.callWorkflow: redis SET meta failed: {e}"))?;
            }
            if let Some(nats) = &hctx.nats {
                let start_subject = format!("wf.{project_id}.{callee_instance_id}.start");
                let mut start_val = serde_json::json!({
                    "unitPath": unit_path,
                    "instanceId": callee_instance_id,
                    "input": data_json,
                });
                if let Some(obj) = start_val.as_object_mut() {
                    crate::telemetry::inject_traceparent_json_field(obj);
                }
                let start_payload = start_val.to_string();
                nats.publish(start_subject, bytes::Bytes::from(start_payload)).await
                    .map_err(|e| format!("sdk.callWorkflow: nats publish start failed: {e}"))?;
            }
            Ok(())
        })
    });
    let out = match &res {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    record_sdk_output_json(&span, &out);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

// ---------------------------------------------------------------------------
// SdkComm host functions (register_sdk_comm) — used by all unit types
// ---------------------------------------------------------------------------

pub fn register_sdk_comm(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals().set("__baal_get_api_unit_trigger_url", Func::from(host_get_api_unit_trigger_url))?;
    ctx.globals().set("__baal_call_actor_sync", Func::from(host_call_actor_sync))?;
    ctx.globals().set("__baal_call_actor_async", Func::from(host_call_actor_async))?;
    ctx.globals().set("__baal_enqueue_worker", Func::from(host_enqueue_worker))?;
    ctx.globals().set("__baal_call_workflow_sync", Func::from(host_call_workflow_sync))?;
    ctx.globals().set("__baal_start_workflow_fire_forget", Func::from(host_start_workflow_fire_forget))?;
    ctx.globals().set("__baal_call_workflow_handler_sync", Func::from(host_call_workflow_handler_sync))?;
    ctx.globals().set("__baal_start_actor_call", Func::from(host_start_actor_call))?;
    ctx.globals().set("__baal_get_secure_env", Func::from(host_get_secure_env))?;
    Ok(())
}

fn host_get_secure_env(ctx: Ctx<'_>, key: String) -> rquickjs::Result<String> {
    use crate::services::runtime_env::{self, RuntimeEnvError};

    let span = sdk_span!("sdk.getSecureEnv");
    let _g = span.enter();
    let input = serde_json::json!({ "key": &key });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        sdk_record_release_and_runtime_ids(&span, comm.as_ref());
        let project_id = Uuid::parse_str(comm.project_id.as_str())
            .map_err(|_| "sdk.getSecureEnv: invalid project id".to_string())?;
        let pool = comm.pool.clone();
        let redis = comm.redis_conn.clone();
        let resolved_runtime_id = comm.resolved_runtime_id;
        let runtime_id = resolved_runtime_id.ok_or_else(|| {
            "sdk.getSecureEnv: resolved_runtime_id is not set".to_string()
        })?;
        runtime_env::get_secure_env_blocking(&pool, &redis, project_id, runtime_id, &key)
            .map_err(|e| match e {
                    RuntimeEnvError::NotFound(k) => {
                        format!("sdk.getSecureEnv: env var not found: {k}")
                    }
                    RuntimeEnvError::InvalidKey => {
                        "sdk.getSecureEnv: key must be non-empty".to_string()
                    }
                    RuntimeEnvError::EncryptionKeyMissing => {
                        "sdk.getSecureEnv: encryption key missing for runtime".to_string()
                    }
                    RuntimeEnvError::Decrypt(msg) => {
                        format!("sdk.getSecureEnv: decrypt failed: {msg}")
                    }
                    RuntimeEnvError::Db(e) => format!("sdk.getSecureEnv: database error: {e}"),
                    RuntimeEnvError::Redis(e) => format!("sdk.getSecureEnv: cache error: {e}"),
                })
    });
    let out_json = match &res {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    record_sdk_output_json(&span, &out_json);
    let out_str = out_json.to_string();
    match res {
        Ok(_) => Ok(out_str),
        Err(e) => Err(Exception::throw_message(&ctx, &e)),
    }
}

fn host_get_api_unit_trigger_url(ctx: Ctx<'_>, args_json: String) -> rquickjs::Result<String> {
    let parsed: serde_json::Value = serde_json::from_str(&args_json).map_err(|e| {
        Exception::throw_message(
            &ctx,
            &format!("sdk.getApiUnitTriggerUrl: invalid args JSON: {e}"),
        )
    })?;
    let unit_path_or_id = parsed
        .get("unitPathOrId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Exception::throw_message(&ctx, "sdk.getApiUnitTriggerUrl: unitPathOrId is required"))?;
    let span = sdk_span!("sdk.getApiUnitTriggerUrl");
    let _g = span.enter();
    let input = serde_json::json!({ "unitPathOrId": unit_path_or_id });
    record_sdk_input(&span, &input);
    let res = with_comm_ctx(|comm| compute_api_unit_trigger_url(comm.as_ref(), unit_path_or_id));
    let out_json = match &res {
        Ok(url) => serde_json::json!({ "ok": true, "url": url }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    record_sdk_output_json(&span, &out_json);
    let out_str = out_json.to_string();
    match res {
        Ok(_) => Ok(out_str),
        Err(e) => Err(Exception::throw_message(&ctx, &e)),
    }
}

fn host_call_actor_sync(
    ctx: Ctx<'_>,
    unit_path: String,
    actor_id: String,
    handler: String,
    payload_json: String,
    timeout_ms: f64,
) -> rquickjs::Result<String> {
    use crate::libs::unit_js::actor_runner::ActorKind;
    use crate::services::actor_worker::manager::{ActorRunInput, run_actor_with_lock};

    let span = sdk_span!("sdk.callActorAndWaitForResultSync");
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "actorId": &actor_id,
        "handler": &handler,
        "payload": json_payload_field(&payload_json),
        "timeoutMs": timeout_ms,
    });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        sdk_record_release_and_runtime_ids(&span, comm.as_ref());
        if comm.actor_redis.is_none() {
            return Err("sdk.callActor: actor Redis not configured".to_string());
        }
        let comm_clone = comm.clone();
        let timeout = std::time::Duration::from_millis(timeout_ms as u64);

        let parts: Vec<&str> = unit_path.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("sdk.callActor: invalid unitPath '{unit_path}' — expected 4 dot-separated segments"));
        }
        if parts[2] != "actor" {
            return Err(format!("sdk.callActor: unit type '{}' is not 'actor'", parts[2]));
        }

        let input = ActorRunInput {
            project_id: comm.project_id.clone(),
            unit_path,
            actor_id,
            handler,
            payload_json,
            kind: ActorKind::Handler,
            alarm_name: None,
            error_msg: None,
        };
        let span_run = span.clone();
        block_async(
            async move {
                match tokio::time::timeout(timeout, run_actor_with_lock(input, comm_clone, None)).await {
                    Ok(Ok(out)) => {
                        Ok(serde_json::json!({ "ok": true, "result": out.result }).to_string())
                    }
                    Ok(Err(e)) => Ok(serde_json::json!({ "ok": false, "error": e }).to_string()),
                    Err(_) => Ok(serde_json::json!({ "ok": false, "error": format!("sdk.callActor: timed out after {}ms", timeout_ms as u64) }).to_string()),
                }
            }
            .instrument(span_run),
        )
    });
    record_sdk_output_result_str(&span, &res);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_call_actor_async(
    ctx: Ctx<'_>,
    unit_path: String,
    actor_id: String,
    handler: String,
    payload_json: String,
) -> rquickjs::Result<String> {
    use crate::services::actor_engine::publish_actor_message;

    let span = sdk_span!("sdk.sendActorMessageSync");
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "actorId": &actor_id,
        "handler": &handler,
        "payload": json_payload_field(&payload_json),
    });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        sdk_record_release_and_runtime_ids(&span, comm.as_ref());
        let actor_js = comm.actor_js.clone()
            .ok_or_else(|| "sdk.callActor (fire-forget): actor NATS JetStream not configured".to_string())?;
        let project_id = comm.project_id.clone();
        let stage_s: Option<String> = comm.stage_runtime_id.map(|u| u.to_string());
        let span_run = span.clone();
        block_async(
            async move {
                publish_actor_message(
                    &actor_js,
                    &project_id,
                    &unit_path,
                    &actor_id,
                    &handler,
                    &payload_json,
                    None,
                    stage_s.as_deref(),
                )
                .await?;
                Ok(serde_json::json!({ "delivered": true }).to_string())
            }
            .instrument(span_run),
        )
    });
    record_sdk_output_result_str(&span, &res);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_enqueue_worker(
    ctx: Ctx<'_>,
    unit_path: String,
    data_json: String,
) -> rquickjs::Result<String> {
    use crate::services::queue_worker_engine::enqueue_queue_worker_run;

    let span = sdk_span!("sdk.enqueueWorkerSync");
    let _g = span.enter();
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "data": json_payload_field(&data_json),
    });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        let wq_redis = comm.wq_redis.clone()
            .ok_or_else(|| "sdk.enqueueWorker: queue-worker Redis not configured".to_string())?;
        let wq_nats = comm.wq_nats.clone();
        let wq_js = comm.wq_js.clone();
        let project_id = comm.project_id.clone();

        let parts: Vec<&str> = unit_path.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("sdk.enqueueWorker: invalid unitPath '{unit_path}' — expected 4 dot-separated segments"));
        }
        if parts[2] != "queue_worker" {
            return Err(format!("sdk.enqueueWorker: unit type '{}' is not 'queue_worker'", parts[2]));
        }

        let stage = comm.stage_runtime_id;
        block_async(async move {
            let result = enqueue_queue_worker_run(
                &wq_redis,
                &wq_nats,
                &wq_js,
                &project_id,
                &unit_path,
                &data_json,
                stage,
            )
            .await?;
            serde_json::to_string(&result).map_err(|e| e.to_string())
        })
    });
    record_sdk_output_result_str(&span, &res);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_call_workflow_sync(
    ctx: Ctx<'_>,
    unit_path: String,
    input_json: String,
    timeout_ms: f64,
) -> rquickjs::Result<String> {
    use crate::models::projects::ProjectUnitType;
    use crate::services::project_release::load_unit_for_path_scoped;
    use crate::services::workflow_engine::start_workflow;

    let span = sdk_span!("sdk.callWorkflowAndWaitForOutputSync");
    let _g = span.enter();
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "input": json_payload_field(&input_json),
        "timeoutMs": timeout_ms,
    });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        let wf_redis = comm.wf_redis.clone()
            .ok_or_else(|| "sdk.callWorkflow: workflow Redis not configured".to_string())?;
        let wf_nats = comm.wf_nats.clone()
            .ok_or_else(|| "sdk.callWorkflow: NATS not configured (required for completion events)".to_string())?;
        let wf_js = comm.wf_js.clone();
        let pool = comm.pool.clone();
        let redis_conn = comm.redis_conn.clone();
        let project_id = comm.project_id.clone();
        let timeout = std::time::Duration::from_millis(timeout_ms as u64);

        let parts: Vec<&str> = unit_path.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("sdk.callWorkflow: invalid unitPath '{unit_path}' — expected 4 segments"));
        }
        if parts[2] != "workflow" {
            let label = if parts[2] == "api" { "API unit" } else { parts[2] };
            return Err(format!("sdk.callWorkflow: target is an {label}, not a workflow unit"));
        }

        let comm_arc = comm.clone();
        let stage = comm_arc.stage_runtime_id;
        block_async(async move {
            let project_uuid = uuid::Uuid::parse_str(&project_id)
                .map_err(|e| format!("invalid project_id: {e}"))?;

            let unit = load_unit_for_path_scoped(&pool, &redis_conn, project_uuid, stage, ProjectUnitType::Workflow, &unit_path)
                .await
                .map_err(|e| format!("sdk.callWorkflow: load unit error: {e}"))?
                .ok_or_else(|| format!("sdk.callWorkflow: workflow unit not found: {unit_path}"))?;

            let source = unit.compiled_code.as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or("sdk.callWorkflow: workflow unit has no compiled code")?
                .to_string();

            let instance_id = crate::libs::ids::new_uuid().to_string();

            let wildcard_subject = format!("wf.events.{project_id}.workflow.>");
            let mut sub = wf_nats.subscribe(wildcard_subject).await
                .map_err(|e| format!("sdk.callWorkflow: NATS subscribe failed: {e}"))?;

            let callee_comm = comm_arc.for_unit(project_id.clone(), unit_path.clone(), Some(instance_id.clone()));
            let wf_nats_for_start = Some(wf_nats.clone());
            start_workflow(&wf_redis, &wf_nats_for_start, &wf_js, &project_id, &unit_path, &instance_id, &input_json, &source, callee_comm).await?;

            match tokio::time::timeout(timeout, async {
                while let Some(msg) = sub.next().await {
                    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&msg.payload) else { continue };
                    let iid = payload.get("instanceId").and_then(|v| v.as_str()).unwrap_or("");
                    if iid != instance_id { continue; }
                    let event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("");
                    match event {
                        "workflow.completed" => {
                            let raw = payload.get("result").cloned().unwrap_or(serde_json::Value::Null);
                            let value = raw.as_str()
                                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                                .unwrap_or(raw);
                            return Ok::<String, String>(serde_json::json!({ "ok": true, "value": value }).to_string());
                        }
                        "workflow.failed" | "workflow.cancelled" => {
                            let error = payload.get("error").and_then(|v| v.as_str()).unwrap_or("workflow ended").to_string();
                            return Ok(serde_json::json!({ "ok": false, "error": error }).to_string());
                        }
                        _ => {}
                    }
                }
                Err("sdk.callWorkflow: NATS subscription closed unexpectedly".to_string())
            })
            .await
            {
                Ok(result) => result,
                Err(_) => Ok(serde_json::json!({ "ok": false, "error": format!("sdk.callWorkflow: timed out after {}ms", timeout_ms as u64) }).to_string()),
            }
        })
    });
    record_sdk_output_result_str(&span, &res);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

/// Fire-and-forget workflow start: creates the instance, spawns drive in the
/// background, and returns `{ instanceId }` immediately. Used by
/// `sdk.callWorkflow(path, data, { awaitResult: false })`.
fn host_start_workflow_fire_forget(
    ctx: Ctx<'_>,
    unit_path: String,
    input_json: String,
) -> rquickjs::Result<String> {
    use crate::models::projects::ProjectUnitType;
    use crate::services::project_release::load_unit_for_path_scoped;
    use crate::services::workflow_engine::{drive_workflow, prepare_workflow_instance_for_start};

    let span = sdk_span!("sdk.startWorkflowSync");
    let _g = span.enter();
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "input": json_payload_field(&input_json),
    });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        let wf_redis = comm.wf_redis.clone()
            .ok_or_else(|| "sdk.callWorkflow: workflow Redis not configured".to_string())?;
        let wf_nats = comm.wf_nats.clone();
        let wf_js = comm.wf_js.clone();
        let pool = comm.pool.clone();
        let redis_conn = comm.redis_conn.clone();
        let project_id = comm.project_id.clone();

        let parts: Vec<&str> = unit_path.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("sdk.callWorkflow: invalid unitPath '{unit_path}' — expected 4 segments (context.module.workflow.name)"));
        }
        if parts[2] != "workflow" {
            let label = if parts[2] == "api" { "API unit" } else { parts[2] };
            return Err(format!("sdk.callWorkflow: target is an {label}, not a workflow unit"));
        }

        let comm_arc = comm.clone();
        let stage = comm_arc.stage_runtime_id;
        block_async(async move {
            let project_uuid = uuid::Uuid::parse_str(&project_id)
                .map_err(|e| format!("invalid project_id: {e}"))?;

            let unit = load_unit_for_path_scoped(&pool, &redis_conn, project_uuid, stage, ProjectUnitType::Workflow, &unit_path)
                .await
                .map_err(|e| format!("sdk.callWorkflow: load unit error: {e}"))?
                .ok_or_else(|| format!("sdk.callWorkflow: workflow unit not found: {unit_path}"))?;

            let source = unit.compiled_code.as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or("sdk.callWorkflow: workflow unit has no compiled code")?
                .to_string();

            let instance_id = crate::libs::ids::new_uuid().to_string();
            let callee_comm = comm_arc.for_unit(project_id.clone(), unit_path.clone(), Some(instance_id.clone()));

            let effective_id = prepare_workflow_instance_for_start(
                &wf_redis,
                &wf_nats,
                &wf_js,
                &project_id,
                &unit_path,
                &instance_id,
                &input_json,
                &source,
                callee_comm.clone(),
            )
            .await?;

            if effective_id == instance_id {
                let wf_redis_bg = wf_redis.clone();
                let wf_nats_bg = wf_nats.clone();
                let wf_js_bg = wf_js.clone();
                let project_id_bg = project_id.clone();
                let unit_path_bg = unit_path.clone();
                let instance_id_bg = instance_id.clone();
                let input_json_bg = input_json.clone();
                let source_bg = source.clone();
                let comm_bg = callee_comm;
                let rid_bg = comm_bg.stage_runtime_id.map(|u| u.to_string());
                let trigger_rt_bg = if comm_bg.stage_runtime_id.is_some() {
                    Some("stage")
                } else {
                    Some("production")
                };
                let parent_ctx_bg = crate::telemetry::context_with_telemetry_baggage(
                    tracing::Span::current().context(),
                    Some(project_id_bg.as_str()),
                    trigger_rt_bg,
                    rid_bg.as_deref(),
                );
                let drive_span = tracing::Span::current();
                tokio::spawn(
                    async move {
                        if let Err(e) = drive_workflow(
                            &wf_redis_bg,
                            &wf_nats_bg,
                            &wf_js_bg,
                            &project_id_bg,
                            &instance_id_bg,
                            &input_json_bg,
                            &source_bg,
                            None,
                            None,
                            comm_bg,
                        )
                        .await
                        {
                            tracing::error!(error = %e, unit_path = %unit_path_bg, instance_id = %instance_id_bg, "fire-and-forget workflow drive failed");
                        }
                    }
                    .instrument(drive_span)
                    .with_context(parent_ctx_bg),
                );
            }

            Ok(serde_json::json!({ "instanceId": effective_id }).to_string())
        })
    });
    record_sdk_output_result_str(&span, &res);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

/// Blocking call to invoke a shared handler on a running workflow instance.
/// Used by `sdk.callWorkflowHandler(path, instanceId, handler, input, opts?)`.
fn host_call_workflow_handler_sync(
    ctx: Ctx<'_>,
    unit_path: String,
    instance_id: String,
    handler_name: String,
    input_json: String,
    timeout_ms: f64,
) -> rquickjs::Result<String> {
    use crate::models::projects::ProjectUnitType;
    use crate::services::project_release::load_unit_for_path_scoped;
    use crate::services::workflow_engine::call_handler;

    let span = sdk_span!("sdk.callWorkflowHandlerAndWaitForResultSync");
    let _g = span.enter();
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "instanceId": &instance_id,
        "handler": &handler_name,
        "input": json_payload_field(&input_json),
        "timeoutMs": timeout_ms,
    });
    record_sdk_input(&span, &input);
    let res: Result<String, String> = with_comm_ctx(|comm| {
        let wf_redis = comm.wf_redis.clone()
            .ok_or_else(|| "sdk.callWorkflowHandler: workflow Redis not configured".to_string())?;
        let wf_nats = comm.wf_nats.clone();
        let wf_js = comm.wf_js.clone();
        let pool = comm.pool.clone();
        let redis_conn = comm.redis_conn.clone();
        let project_id = comm.project_id.clone();
        let timeout = std::time::Duration::from_millis(timeout_ms as u64);

        let parts: Vec<&str> = unit_path.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("sdk.callWorkflowHandler: invalid unitPath '{unit_path}' — expected 4 segments"));
        }
        if parts[2] != "workflow" {
            let label = if parts[2] == "api" { "API unit" } else { parts[2] };
            return Err(format!("sdk.callWorkflowHandler: target is an {label}, not a workflow unit"));
        }
        if handler_name.is_empty() {
            return Err("sdk.callWorkflowHandler: handler name is required".to_string());
        }
        if instance_id.is_empty() {
            return Err("sdk.callWorkflowHandler: instanceId is required".to_string());
        }

        let comm_arc = comm.clone();
        let stage = comm_arc.stage_runtime_id;
        block_async(async move {
            let project_uuid = uuid::Uuid::parse_str(&project_id)
                .map_err(|e| format!("invalid project_id: {e}"))?;

            let unit = load_unit_for_path_scoped(&pool, &redis_conn, project_uuid, stage, ProjectUnitType::Workflow, &unit_path)
                .await
                .map_err(|e| format!("sdk.callWorkflowHandler: load unit error: {e}"))?
                .ok_or_else(|| format!("sdk.callWorkflowHandler: workflow unit not found: {unit_path}"))?;

            let source = unit.compiled_code.as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or("sdk.callWorkflowHandler: workflow unit has no compiled code")?
                .to_string();

            let callee_comm = comm_arc.for_unit(project_id.clone(), unit_path.clone(), Some(instance_id.clone()));

            match tokio::time::timeout(
                timeout,
                call_handler(&wf_redis, &wf_nats, &wf_js, &project_id, &instance_id, &handler_name, &input_json, &source, callee_comm),
            ).await {
                Ok(Ok(result)) => {
                    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap_or(serde_json::Value::Null);
                    Ok(serde_json::json!({ "ok": true, "value": parsed }).to_string())
                }
                Ok(Err(e)) => Ok(serde_json::json!({ "ok": false, "error": e }).to_string()),
                Err(_) => Ok(serde_json::json!({ "ok": false, "error": format!("sdk.callWorkflowHandler: timed out after {}ms", timeout_ms as u64) }).to_string()),
            }
        })
    });
    record_sdk_output_result_str(&span, &res);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

/// Workflow-only: seeds a durable promise and fires the actor via JetStream.
/// The actor worker resolves/rejects the promise when it finishes (via the
/// `wf.promise.{pid}.{iid}.{name}` reply subject).
fn host_start_actor_call(
    ctx: Ctx<'_>,
    unit_path: String,
    actor_id: String,
    handler: String,
    payload_json: String,
    promise_name: String,
) -> rquickjs::Result<()> {
    use crate::services::actor_engine::publish_actor_message;

    let span = sdk_span!("workflow.durable.startActorCall");
    let input = serde_json::json!({
        "unitPath": &unit_path,
        "actorId": &actor_id,
        "handler": &handler,
        "payload": json_payload_field(&payload_json),
        "promiseName": &promise_name,
    });
    record_sdk_input(&span, &input);
    let res: Result<(), String> = with_host_ctx(|hctx| {
            let project_id = hctx.project_id.clone();
            let caller_instance_id = hctx.instance_id.clone();

            let actor_js = COMM_CTX.with(|c| {
                c.borrow().as_ref().and_then(|comm| comm.actor_js.clone())
            })
            .ok_or_else(|| "__baal_start_actor_call: actor NATS JetStream not configured".to_string())?;

            let reply_subject =
                format!("wf.promise.{project_id}.{caller_instance_id}.{promise_name}");

            let stage_s: Option<String> = COMM_CTX.with(|c| {
                c.borrow()
                    .as_ref()
                    .and_then(|co| co.stage_runtime_id.map(|u| u.to_string()))
            });

            let span_run = span.clone();
            block_async(
                async move {
                    publish_actor_message(
                        &actor_js,
                        &project_id,
                        &unit_path,
                        &actor_id,
                        &handler,
                        &payload_json,
                        Some(&reply_subject),
                        stage_s.as_deref(),
                    )
                    .await
                    .map_err(|e| format!("__baal_start_actor_call: publish failed: {e}"))?;

                    Ok(())
                }
                .instrument(span_run),
            )
        });
    let out = match &res {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    record_sdk_output_json(&span, &out);
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

// Keep the old `register` name as an alias so existing call sites compile
// during the migration.
#[deprecated(note = "use register_workflow_persistence")]
pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    register_workflow_persistence(ctx)
}

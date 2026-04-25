use async_nats::jetstream;
use futures::StreamExt;
use rquickjs::{Ctx, Exception, Value, function::Func};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::database::{DbPool, SharedRedisConn};
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
    pub actor_locks: SdkActorLocks,
    pub project_id: String,
    pub source_unit_path: String,
    pub source_instance_id: Option<String>,
    pub stage_runtime_id: Option<Uuid>,
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
    F: std::future::Future<Output = Result<R, String>>,
{
    tokio::runtime::Handle::current().block_on(future)
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
                let payload = serde_json::json!({ "reason": "promise_resolved", "promise": name }).to_string();
                nats.publish(subject, bytes::Bytes::from(payload)).await
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
                let payload = serde_json::json!({ "reason": "promise_rejected", "promise": name }).to_string();
                nats.publish(subject, bytes::Bytes::from(payload)).await
                    .map_err(|e| format!("nats publish wake failed: {e}"))?;
            }
            Ok(())
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_start_call(ctx: Ctx<'_>, unit_path: String, data_json: String, promise_name: String) -> rquickjs::Result<()> {
    with_host_ctx(|hctx| {
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
                let start_payload = serde_json::json!({
                    "unitPath": unit_path,
                    "instanceId": callee_instance_id,
                    "input": data_json,
                })
                .to_string();
                nats.publish(start_subject, bytes::Bytes::from(start_payload)).await
                    .map_err(|e| format!("sdk.callWorkflow: nats publish start failed: {e}"))?;
            }
            Ok(())
        })
    })
    .map_err(|e| Exception::throw_message(&ctx, &e))
}

// ---------------------------------------------------------------------------
// SdkComm host functions (register_sdk_comm) — used by all unit types
// ---------------------------------------------------------------------------

pub fn register_sdk_comm(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals().set("__baal_call_actor_sync", Func::from(host_call_actor_sync))?;
    ctx.globals().set("__baal_call_actor_async", Func::from(host_call_actor_async))?;
    ctx.globals().set("__baal_enqueue_worker", Func::from(host_enqueue_worker))?;
    ctx.globals().set("__baal_call_workflow_sync", Func::from(host_call_workflow_sync))?;
    ctx.globals().set("__baal_start_workflow_fire_forget", Func::from(host_start_workflow_fire_forget))?;
    ctx.globals().set("__baal_call_workflow_handler_sync", Func::from(host_call_workflow_handler_sync))?;
    ctx.globals().set("__baal_start_actor_call", Func::from(host_start_actor_call))?;
    Ok(())
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

    let res: Result<String, String> = with_comm_ctx(|comm| {
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
        block_async(async move {
            match tokio::time::timeout(timeout, run_actor_with_lock(input, comm_clone)).await {
                Ok(Ok(out)) => Ok(serde_json::json!({ "ok": true, "result": out.result }).to_string()),
                Ok(Err(e)) => Ok(serde_json::json!({ "ok": false, "error": e }).to_string()),
                Err(_) => Ok(serde_json::json!({ "ok": false, "error": format!("sdk.callActor: timed out after {}ms", timeout_ms as u64) }).to_string()),
            }
        })
    });
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

    let res: Result<String, String> = with_comm_ctx(|comm| {
        let actor_js = comm.actor_js.clone()
            .ok_or_else(|| "sdk.callActor (fire-forget): actor NATS JetStream not configured".to_string())?;
        let project_id = comm.project_id.clone();
        let stage_s: Option<String> = comm.stage_runtime_id.map(|u| u.to_string());
        block_async(async move {
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
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_enqueue_worker(
    ctx: Ctx<'_>,
    unit_path: String,
    data_json: String,
) -> rquickjs::Result<String> {
    use crate::services::queue_worker_engine::enqueue_queue_worker_run;

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
    use crate::services::workflow_engine::start_workflow;

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

            let wf_redis_bg = wf_redis.clone();
            let wf_nats_bg = wf_nats.clone();
            let wf_js_bg = wf_js.clone();
            let project_id_bg = project_id.clone();
            let unit_path_bg = unit_path.clone();
            let instance_id_bg = instance_id.clone();
            let input_json_bg = input_json.clone();
            let source_bg = source.clone();
            tokio::spawn(async move {
                if let Err(e) = start_workflow(
                    &wf_redis_bg,
                    &wf_nats_bg,
                    &wf_js_bg,
                    &project_id_bg,
                    &unit_path_bg,
                    &instance_id_bg,
                    &input_json_bg,
                    &source_bg,
                    callee_comm,
                ).await {
                    tracing::error!(error = %e, unit_path = %unit_path_bg, instance_id = %instance_id_bg, "fire-and-forget workflow start failed");
                }
            });

            Ok(serde_json::json!({ "instanceId": instance_id }).to_string())
        })
    });
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

    let res: Result<(), String> = with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        let caller_instance_id = hctx.instance_id.clone();

        let actor_js = COMM_CTX.with(|c| {
            c.borrow().as_ref().and_then(|comm| comm.actor_js.clone())
        })
        .ok_or_else(|| "__baal_start_actor_call: actor NATS JetStream not configured".to_string())?;

        let reply_subject = format!("wf.promise.{project_id}.{caller_instance_id}.{promise_name}");

        let stage_s: Option<String> =
            COMM_CTX.with(|c| c.borrow().as_ref().and_then(|co| co.stage_runtime_id.map(|u| u.to_string())));

        block_async(async move {
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
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

// Keep the old `register` name as an alias so existing call sites compile
// during the migration.
#[deprecated(note = "use register_workflow_persistence")]
pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    register_workflow_persistence(ctx)
}

use rquickjs::{Ctx, Exception, Value, function::Func};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Rust-side handle to Redis/NATS used by workflow host functions.
///
/// **Security boundary**: this struct is stored in a Rust thread-local and is
/// NEVER injected into the QuickJS JS context. JS code can only reach Redis/NATS
/// indirectly through the opaque host functions registered in [`register`]
/// (e.g. `__baal_persist_step`), which accept and return plain strings.
/// Fields are crate-private to `unit_js` so only the workflow runner can construct it.
pub struct WorkflowHostCtx {
    pub(in crate::libs::unit_js) redis: Arc<Mutex<redis::aio::MultiplexedConnection>>,
    pub(in crate::libs::unit_js) nats: Option<async_nats::Client>,
    pub(in crate::libs::unit_js) project_id: String,
    pub(in crate::libs::unit_js) instance_id: String,
}

std::thread_local! {
    static HOST_CTX: std::cell::RefCell<Option<Arc<WorkflowHostCtx>>> = const { std::cell::RefCell::new(None) };
}

pub fn set_host_ctx(ctx: Arc<WorkflowHostCtx>) {
    HOST_CTX.with(|c| {
        *c.borrow_mut() = Some(ctx);
    });
}

pub fn clear_host_ctx() {
    HOST_CTX.with(|c| {
        *c.borrow_mut() = None;
    });
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
    tokio::runtime::Handle::current()
        .block_on(future)
}

fn redis_key(project_id: &str, instance_id: &str, suffix: &str) -> String {
    format!("wf:{project_id}:{instance_id}:{suffix}")
}

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals().set(
        "__baal_persist_step",
        Func::from(host_persist_step),
    )?;
    ctx.globals().set(
        "__baal_persist_step_error",
        Func::from(host_persist_step_error),
    )?;
    ctx.globals().set(
        "__baal_persist_sleep",
        Func::from(host_persist_sleep),
    )?;
    ctx.globals().set(
        "__baal_persist_state",
        Func::from(host_persist_state),
    )?;
    ctx.globals().set(
        "__baal_read_state",
        Func::from(host_read_state),
    )?;
    ctx.globals().set(
        "__baal_resolve_promise",
        Func::from(host_resolve_promise),
    )?;
    ctx.globals().set(
        "__baal_reject_promise",
        Func::from(host_reject_promise),
    )?;
    ctx.globals().set(
        "__baal_call",
        Func::from(host_call),
    )?;
    Ok(())
}

fn host_persist_step(ctx: Ctx<'_>, name: String, result_json: String, _opts_json: String) -> rquickjs::Result<()> {
    let res = with_host_ctx(|hctx| {
        block_async(async {
            let key = redis_key(&hctx.project_id, &hctx.instance_id, &format!("step:{name}"));
            let value = serde_json::json!({
                "status": "completed",
                "result": result_json,
            })
            .to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&key)
                .arg(&value)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET step failed: {e}"))
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_persist_step_error(
    ctx: Ctx<'_>,
    name: String,
    error_msg: String,
    is_terminal: bool,
    _opts_json: String,
) -> rquickjs::Result<()> {
    let res = with_host_ctx(|hctx| {
        block_async(async {
            let key = redis_key(&hctx.project_id, &hctx.instance_id, &format!("step:{name}"));
            let value = serde_json::json!({
                "status": "failed",
                "error": error_msg,
                "terminal": is_terminal,
            })
            .to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&key)
                .arg(&value)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET step error failed: {e}"))
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_persist_sleep(ctx: Ctx<'_>, name: String, _duration_ms: f64) -> rquickjs::Result<()> {
    let res = with_host_ctx(|hctx| {
        block_async(async {
            let key = redis_key(&hctx.project_id, &hctx.instance_id, &format!("sleep:{name}"));
            let value = serde_json::json!({
                "elapsed": true,
            })
            .to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&key)
                .arg(&value)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET sleep failed: {e}"))
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_persist_state(ctx: Ctx<'_>, key: String, value_json: String) -> rquickjs::Result<()> {
    let res = with_host_ctx(|hctx| {
        block_async(async {
            let rkey = redis_key(&hctx.project_id, &hctx.instance_id, &format!("state:{key}"));
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&rkey)
                .arg(&value_json)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET state failed: {e}"))
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_read_state<'js>(ctx: Ctx<'js>, key: String) -> rquickjs::Result<Value<'js>> {
    let res: Result<Option<String>, String> = with_host_ctx(|hctx| {
        block_async(async {
            let rkey = redis_key(&hctx.project_id, &hctx.instance_id, &format!("state:{key}"));
            let mut conn = hctx.redis.lock().await;
            redis::cmd("GET")
                .arg(&rkey)
                .query_async::<Option<String>>(&mut *conn)
                .await
                .map_err(|e| format!("redis GET state failed: {e}"))
        })
    });
    match res {
        Ok(Some(v)) => rquickjs::String::from_str(ctx.clone(), &v)
            .map(|s| s.into_value()),
        Ok(None) => Ok(Value::new_null(ctx)),
        Err(e) => Err(Exception::throw_message(&ctx, &e)),
    }
}

fn host_resolve_promise(ctx: Ctx<'_>, name: String, value_json: String) -> rquickjs::Result<()> {
    let res = with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        let instance_id = hctx.instance_id.clone();
        block_async(async {
            let rkey = redis_key(&project_id, &instance_id, &format!("promise:{name}"));
            let value = serde_json::json!({
                "status": "resolved",
                "value": value_json,
            })
            .to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&rkey)
                .arg(&value)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET promise failed: {e}"))?;

            if let Some(nats) = &hctx.nats {
                let subject = format!("wf.{project_id}.{instance_id}.wake");
                let payload = serde_json::json!({
                    "reason": "promise_resolved",
                    "promise": name,
                })
                .to_string();
                nats.publish(subject, bytes::Bytes::from(payload))
                    .await
                    .map_err(|e| format!("nats publish wake failed: {e}"))?;
            }
            Ok(())
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

fn host_reject_promise(ctx: Ctx<'_>, name: String, error: String) -> rquickjs::Result<()> {
    let res = with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        let instance_id = hctx.instance_id.clone();
        block_async(async {
            let rkey = redis_key(&project_id, &instance_id, &format!("promise:{name}"));
            let value = serde_json::json!({
                "status": "rejected",
                "error": error,
            })
            .to_string();
            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&rkey)
                .arg(&value)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET promise reject failed: {e}"))?;

            if let Some(nats) = &hctx.nats {
                let subject = format!("wf.{project_id}.{instance_id}.wake");
                let payload = serde_json::json!({
                    "reason": "promise_rejected",
                    "promise": name,
                })
                .to_string();
                nats.publish(subject, bytes::Bytes::from(payload))
                    .await
                    .map_err(|e| format!("nats publish wake failed: {e}"))?;
            }
            Ok(())
        })
    });
    res.map_err(|e| Exception::throw_message(&ctx, &e))
}

/// `sdk.call(unitPath, dataJson)` — currently supports workflow units only.
/// Starts a new workflow instance and polls for its completion.
fn host_call<'js>(ctx: Ctx<'js>, unit_path: String, data_json: String) -> rquickjs::Result<Value<'js>> {
    let res: Result<Option<String>, String> = with_host_ctx(|hctx| {
        let project_id = hctx.project_id.clone();
        block_async(async {
            let parts: Vec<&str> = unit_path.split('.').collect();
            if parts.len() != 4 {
                return Err(format!(
                    "sdk.call: invalid unit path '{}' — expected context.module.unitType.name",
                    unit_path
                ));
            }
            let unit_type = parts[2];
            if unit_type != "workflow" {
                return Err(format!(
                    "sdk.call: unit type '{}' is not supported yet — only 'workflow' units can be called",
                    unit_type
                ));
            }

            let callee_instance_id = crate::libs::ids::new_uuid().to_string();
            let meta_key = redis_key(&project_id, &callee_instance_id, "meta");
            let result_key = redis_key(&project_id, &callee_instance_id, "result");

            let meta = serde_json::json!({
                "name": unit_path,
                "status": "pending",
                "input": data_json,
                "createdAt": chrono::Utc::now().to_rfc3339(),
                "callerTriggered": true,
            })
            .to_string();

            let mut conn = hctx.redis.lock().await;
            redis::cmd("SET")
                .arg(&meta_key)
                .arg(&meta)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET meta failed: {e}"))?;

            if let Some(nats) = &hctx.nats {
                let subject = format!("wf.{project_id}.{callee_instance_id}.start");
                let payload = serde_json::json!({
                    "unitPath": unit_path,
                    "instanceId": callee_instance_id,
                    "input": data_json,
                })
                .to_string();
                nats.publish(subject, bytes::Bytes::from(payload))
                    .await
                    .map_err(|e| format!("nats publish start failed: {e}"))?;
            }

            // Poll for result (with backoff, max ~30s)
            let mut delay_ms = 50u64;
            let max_wait = std::time::Duration::from_secs(30);
            let start = std::time::Instant::now();
            loop {
                if start.elapsed() > max_wait {
                    return Err(format!(
                        "sdk.call: workflow '{}' did not complete within 30s",
                        unit_path
                    ));
                }
                let result: Option<String> = redis::cmd("GET")
                    .arg(&result_key)
                    .query_async(&mut *conn)
                    .await
                    .map_err(|e| format!("redis GET result failed: {e}"))?;
                if let Some(raw) = result {
                    return Ok(Some(raw));
                }
                drop(conn);
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms * 2).min(2000);
                conn = hctx.redis.lock().await;
            }
        })
    });
    match res {
        Ok(Some(v)) => rquickjs::String::from_str(ctx.clone(), &v).map(|s| s.into_value()),
        Ok(None) => Ok(Value::new_null(ctx)),
        Err(e) => Err(Exception::throw_message(&ctx, &e)),
    }
}

use rquickjs::{AsyncContext, AsyncRuntime, CaughtError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use super::error::log_js_failure;
use super::module_loader::validate_and_prepare_loader;
use super::modules;
use super::modules::sdk::{CommCtxGuard, SdkCommCtx, set_comm_ctx};

const ACTOR_RUNTIME_JS: &str = concat!(
    include_str!("scripts/runtime-shared.js"),
    "\n",
    include_str!("scripts/platform-patches.js"),
    "\n",
    include_str!("scripts/actor-runtime.js")
);

#[derive(Debug, Clone)]
pub struct ActorCtxJson {
    pub actor_id: String,
    pub attempt: u32,
    pub state: Option<Value>,
    pub handler: String,
    pub payload_json: String,
    pub kind: ActorKind,
    pub alarm_name: Option<String>,
    pub error_msg: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorKind {
    Handler,
    Alarm,
    DeadLetter,
}

impl ActorKind {
    fn as_str(&self) -> &'static str {
        match self {
            ActorKind::Handler => "handler",
            ActorKind::Alarm => "alarm",
            ActorKind::DeadLetter => "dead_letter",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAlarm {
    pub name: String,
    pub at: i64,
    #[serde(default)]
    pub relative: bool,
}

#[derive(Debug, Clone)]
pub enum ActorOutcome {
    Completed {
        new_state: Value,
        result: Value,
        state_touched: bool,
        pending_alarms: Vec<PendingAlarm>,
        cancelled_alarms: Vec<String>,
    },
    Retriable(String, Option<Value>),
    Terminal {
        error: String,
        state: Option<Value>,
    },
    UnknownHandler(String),
    StateLimitExceeded(String),
}

pub async fn run_actor_handler(
    source: &str,
    ctx_json: &ActorCtxJson,
    comm: Arc<SdkCommCtx>,
    state_limit_bytes: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<ActorOutcome, String> {
    crate::rt_enter!(
        "js.actor.run_actor_handler",
        actor_id = %ctx_json.actor_id,
        handler = %ctx_json.handler,
        kind = %ctx_json.kind.as_str(),
        timeout_ms = timeout_ms.unwrap_or(0)
    );
    let fut = run_actor_handler_inner(source, ctx_json, comm, state_limit_bytes);
    let out = if let Some(ms) = timeout_ms {
        tokio::time::timeout(std::time::Duration::from_millis(ms), fut)
            .await
            .map_err(|_| "actor timeout expired".to_string())?
    } else {
        fut.await
    };
    match &out {
        Ok(_) => crate::rt_exit_ok!("js.actor.run_actor_handler", actor_id = %ctx_json.actor_id),
        Err(e) => crate::rt_exit_err!("js.actor.run_actor_handler", actor_id = %ctx_json.actor_id, error = %e),
    }
    out
}

async fn run_actor_handler_inner(
    source: &str,
    ctx_json: &ActorCtxJson,
    comm: Arc<SdkCommCtx>,
    state_limit_bytes: Option<u64>,
) -> Result<ActorOutcome, String> {
    let baal = validate_and_prepare_loader(source, None).map_err(|e| e.to_string())?;

    let (llrt_resolver, llrt_loader, attachment) =
        llrt_modules::module_builder::ModuleBuilder::default().build();

    let rt = AsyncRuntime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("actor runtime init", &msg);
        msg
    })?;

    rt.set_loader(
        (baal.clone(), llrt_resolver),
        (llrt_loader, baal),
    )
    .await;

    let ctx = AsyncContext::full(&rt).await.map_err(|e| {
        let msg = e.to_string();
        log_js_failure("actor context init", &msg);
        msg
    })?;

    let actor_ctx_js = build_actor_ctx_js(ctx_json);
    let actor_kind = ctx_json.kind.as_str();
    let state_limit = state_limit_bytes.unwrap_or(1024 * 1024);

    let result = rquickjs::async_with!(ctx => |ctx| {
        set_comm_ctx(comm);
        let _guard = CommCtxGuard;

        let outcome: Result<ActorOutcome, String> = async {
            attachment.attach(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            modules::register_sdk_comm(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            let ctx_val = ctx
                .eval::<rquickjs::Value, _>(format!("({})", actor_ctx_js))
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__baal_actor_ctx", ctx_val)
                .map_err(|e| e.to_string())?;
            ctx.globals()
                .set("__baal_actor_kind", actor_kind)
                .map_err(|e| e.to_string())?;
            ctx.globals()
                .set("__baal_actor_state_limit_bytes", state_limit)
                .map_err(|e| e.to_string())?;

            ctx.eval::<(), _>(ACTOR_RUNTIME_JS)
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let promise: rquickjs::Promise = ctx
                .eval("globalThis.__baal_actor_result")
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            let result_val = promise
                .into_future::<rquickjs::Value>()
                .await
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let result_str: String = result_val
                .as_string()
                .ok_or("actor result is not a string")?
                .to_string()
                .map_err(|e| e.to_string())?;

            parse_actor_result(&result_str)
        }
        .await;

        if let Err(ref msg) = outcome {
            log_js_failure("actor run", msg);
        }
        Ok(outcome)
    })
    .await
    .map_err(|e: rquickjs::Error| e.to_string())??;

    drop(ctx);
    rt.idle().await;
    rt.run_gc().await;

    Ok(result)
}

pub async fn extract_actor_metadata(source: &str) -> ActorMetadata {
    let result: Option<String> = (async {
        let baal = validate_and_prepare_loader(source, None).ok()?;
        let (llrt_resolver, llrt_loader, attachment) =
            llrt_modules::module_builder::ModuleBuilder::default().build();
        let rt = AsyncRuntime::new().ok()?;
        rt.set_loader(
            (baal.clone(), llrt_resolver),
            (llrt_loader, baal),
        )
        .await;
        let ctx = AsyncContext::full(&rt).await.ok()?;

        const METADATA_JS: &str = concat!(
            include_str!("scripts/runtime-shared.js"),
            "\n",
            include_str!("scripts/platform-patches.js"),
            "\n",
            r#"
function actor(config) {
  return {
    __actor_def: true,
    __initial_state: config.state !== undefined ? config.state : {},
    __handlers: config.handlers || {},
    __on_alarm: config.onAlarm || null,
    __on_dead_letter: config.onDeadLetter || null,
    __metadata: config.metadata || {},
  };
}
globalThis.actor = actor;
globalThis.__baal_actor_metadata_p = (async function () {
  var __entry = await import("baal-unit-entry");
  var __actorDef = __entry.default;
  if (!__actorDef || !__actorDef.__actor_def) {
    return JSON.stringify({});
  }
  var meta = __actorDef.__metadata || {};
  var handlers = Object.keys(__actorDef.__handlers || {});
  function __maxIdleToMs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v !== "string") return null;
    var m = String(v).trim().toLowerCase().match(/^(\d+)\s*(ms|s|m|h)$/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    var u = m[2];
    if (u === "ms") return n;
    if (u === "s") return n * 1000;
    if (u === "m") return n * 60 * 1000;
    if (u === "h") return n * 60 * 60 * 1000;
    return null;
  }
  return JSON.stringify({
    handlers: (meta.handlers && Array.isArray(meta.handlers)) ? meta.handlers : handlers,
    retry: meta.retry || null,
    timeout: meta.timeout || null,
    maxIdleTimeMs: __maxIdleToMs(meta.maxIdleTime),
    stateLimitBytes: meta.stateLimitBytes || null,
  });
})();
"#
        );

        let r = rquickjs::async_with!(ctx => |ctx| {
            attachment.attach(&ctx).ok()?;
            ctx.eval::<(), _>(METADATA_JS).ok()?;
            let promise = ctx
                .eval::<rquickjs::Promise, _>("globalThis.__baal_actor_metadata_p")
                .ok()?;
            promise.into_future::<String>().await.ok()
        })
        .await;
        drop(ctx);
        rt.idle().await;
        rt.run_gc().await;
        r
    })
    .await;

    result
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn build_actor_ctx_js(ctx: &ActorCtxJson) -> String {
    let state_json = match &ctx.state {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };
    let payload_escaped = serde_json::to_string(&ctx.payload_json)
        .unwrap_or_else(|_| "\"{}\"".to_string());
    let id_escaped = ctx.actor_id.replace('\\', "\\\\").replace('"', "\\\"");
    let handler_escaped = ctx.handler.replace('\\', "\\\\").replace('"', "\\\"");
    let alarm_name_json = match &ctx.alarm_name {
        Some(n) => format!("\"{}\"", n.replace('\\', "\\\\").replace('"', "\\\"")),
        None => "null".to_string(),
    };
    let error_json = match &ctx.error_msg {
        Some(e) => format!("\"{}\"", e.replace('\\', "\\\\").replace('"', "\\\"")),
        None => "null".to_string(),
    };
    format!(
        r#"{{
  "id": "{id_escaped}",
  "attempt": {attempt},
  "state": {state_json},
  "handler": "{handler_escaped}",
  "payload": {payload_escaped},
  "alarmName": {alarm_name_json},
  "error": {error_json}
}}"#,
        id_escaped = id_escaped,
        attempt = ctx.attempt,
        state_json = state_json,
        handler_escaped = handler_escaped,
        payload_escaped = payload_escaped,
        alarm_name_json = alarm_name_json,
        error_json = error_json,
    )
}

fn json_number_as_i64_ms(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
        .or_else(|| {
            let f = v.as_f64()?;
            if !f.is_finite() {
                return None;
            }
            Some(f as i64)
        })
}

fn parse_actor_result(result_json: &str) -> Result<ActorOutcome, String> {
    let val: Value = serde_json::from_str(result_json)
        .map_err(|e| format!("failed to parse actor result: {e}"))?;

    let ok = val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

    if ok {
        let state_str = val
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let new_state: Value =
            serde_json::from_str(state_str).unwrap_or(Value::Object(Default::default()));
        let result = val.get("value").cloned().unwrap_or(Value::Null);
        let state_touched = val
            .get("state_touched")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let pending_alarms = val
            .get("pending_alarms")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item.get("name")?.as_str()?.to_string();
                        if let Some(ms) = item.get("fireAfterMs").and_then(json_number_as_i64_ms) {
                            return Some(PendingAlarm {
                                name,
                                at: ms,
                                relative: true,
                            });
                        }
                        let at = item.get("at").and_then(json_number_as_i64_ms)?;
                        let relative = item.get("relative").and_then(|v| v.as_bool()).unwrap_or(false);
                        Some(PendingAlarm { name, at, relative })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let cancelled_alarms = val
            .get("cancelled_alarms")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(ActorOutcome::Completed {
            new_state,
            result,
            state_touched,
            pending_alarms,
            cancelled_alarms,
        })
    } else {
        let error = val
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown actor error")
            .to_string();
        let is_terminal = val
            .get("terminal")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let state = val.get("state").and_then(|v| v.as_str()).and_then(|s| {
            serde_json::from_str(s).ok()
        });

        if error.starts_with("UnknownHandler:") {
            return Ok(ActorOutcome::UnknownHandler(error));
        }
        if error.starts_with("StateLimitExceeded:") {
            return Ok(ActorOutcome::StateLimitExceeded(error));
        }
        if is_terminal {
            Ok(ActorOutcome::Terminal { error, state })
        } else {
            Ok(ActorOutcome::Retriable(error, state))
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActorMetadata {
    #[serde(default)]
    pub handlers: Vec<String>,
    pub retry: Option<ActorRetryPolicy>,
    pub timeout: Option<u64>,
    #[serde(rename = "maxIdleTimeMs")]
    pub max_idle_time_ms: Option<u64>,
    #[serde(rename = "stateLimitBytes")]
    pub state_limit_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorRetryPolicy {
    #[serde(rename = "maxAttempts", default = "default_max_attempts")]
    pub max_attempts: u32,
    #[serde(rename = "initialIntervalMs", default = "default_initial_interval_ms")]
    pub initial_interval_ms: u64,
    #[serde(rename = "backoffFactor", default = "default_backoff_factor")]
    pub backoff_factor: f64,
    #[serde(rename = "maxIntervalMs", default = "default_max_interval_ms")]
    pub max_interval_ms: u64,
}

fn default_max_attempts() -> u32 { 3 }
fn default_initial_interval_ms() -> u64 { 1000 }
fn default_backoff_factor() -> f64 { 2.0 }
fn default_max_interval_ms() -> u64 { 300_000 }

impl Default for ActorRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: default_max_attempts(),
            initial_interval_ms: default_initial_interval_ms(),
            backoff_factor: default_backoff_factor(),
            max_interval_ms: default_max_interval_ms(),
        }
    }
}

pub fn actor_backoff_delay(policy: &ActorRetryPolicy, attempt: u32) -> std::time::Duration {
    let delay_ms = (policy.initial_interval_ms as f64
        * policy.backoff_factor.powi((attempt.saturating_sub(1)) as i32))
    .min(policy.max_interval_ms as f64) as u64;
    std::time::Duration::from_millis(delay_ms)
}

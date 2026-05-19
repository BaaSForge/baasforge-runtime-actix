use rquickjs::{Context, Promise, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;

use super::error::{format_js_error, log_js_failure};
use super::module_loader::install_user_module_loader;
use super::modules;
use super::modules::polyfills::EXECUTION_DEADLINE;
use super::modules::sdk::{SdkCommCtx, clear_comm_ctx, set_comm_ctx};

const ACTOR_RUNTIME_JS: &str = concat!(
    include_str!("scripts/runtime-shared.js"),
    "\n",
    include_str!("scripts/actor-runtime.js")
);

const DEFAULT_STATE_LIMIT_BYTES: u64 = 1024 * 1024;

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

pub fn run_actor_handler(
    source: &str,
    ctx_json: &ActorCtxJson,
    comm: Arc<SdkCommCtx>,
    state_limit_bytes: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<ActorOutcome, String> {
    set_comm_ctx(comm);
    let result = run_actor_handler_inner(source, ctx_json, state_limit_bytes, timeout_ms);
    clear_comm_ctx();
    result
}

fn run_actor_handler_inner(
    source: &str,
    ctx_json: &ActorCtxJson,
    state_limit_bytes: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<ActorOutcome, String> {
    let rt = Runtime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("actor runtime init", &msg);
        msg
    })?;
    install_user_module_loader(&rt, source).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("actor module loader init", &msg);
        msg
    })?;
    let ctx = Context::full(&rt).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("actor context init", &msg);
        msg
    })?;

    if let Some(ms) = timeout_ms {
        let deadline = Instant::now() + std::time::Duration::from_millis(ms);
        EXECUTION_DEADLINE.with(|d: &std::cell::Cell<Option<Instant>>| d.set(Some(deadline)));
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    } else {
        EXECUTION_DEADLINE.with(|d: &std::cell::Cell<Option<Instant>>| d.set(None));
    }

    let result = ctx.with(|ctx| run_actor_in_ctx(&ctx, source, ctx_json, state_limit_bytes));

    EXECUTION_DEADLINE.with(|d: &std::cell::Cell<Option<Instant>>| d.set(None));
    result
}

fn run_actor_in_ctx(
    ctx: &rquickjs::Ctx<'_>,
    source: &str,
    actor_ctx: &ActorCtxJson,
    state_limit_bytes: Option<u64>,
) -> Result<ActorOutcome, String> {
    modules::register_all(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("actor register_globals", &msg);
        msg
    })?;

    modules::register_sdk_comm(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("actor register_sdk_comm", &msg);
        msg
    })?;

    let ctx_val = ctx
        .eval::<rquickjs::Value, _>(format!("({})", build_actor_ctx_js(actor_ctx)))
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("actor parse_ctx", &msg);
            msg
        })?;

    ctx.globals().set("__baal_actor_ctx", ctx_val).map_err(|e| e.to_string())?;
    ctx.globals()
        .set("__baal_actor_kind", actor_ctx.kind.as_str())
        .map_err(|e| e.to_string())?;
    ctx.globals()
        .set(
            "__baal_actor_state_limit_bytes",
            state_limit_bytes.unwrap_or(DEFAULT_STATE_LIMIT_BYTES),
        )
        .map_err(|e| e.to_string())?;

    ctx.eval::<(), _>(ACTOR_RUNTIME_JS).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("actor eval_runtime", &msg);
        msg
    })?;

    let promise: Promise = ctx
        .eval::<Promise, _>("globalThis.__baal_actor_result")
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("actor read_promise", &msg);
            msg
        })?;

    let result_val: rquickjs::Value = promise.finish().map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("actor promise_finish", &msg);
        msg
    })?;

    let result_str: String = result_val
        .as_string()
        .ok_or("actor result is not a string")?
        .to_string()
        .map_err(|e| e.to_string())?;

    parse_actor_result(&result_str)
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

pub fn extract_actor_metadata(source: &str) -> ActorMetadata {
    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(_) => return ActorMetadata::default(),
    };
    if install_user_module_loader(&rt, source).is_err() {
        return ActorMetadata::default();
    }
    let ctx = match Context::full(&rt) {
        Ok(ctx) => ctx,
        Err(_) => return ActorMetadata::default(),
    };
    ctx.with(|ctx| -> ActorMetadata {
        let _ = modules::register_all(&ctx);
        let metadata_js = concat!(
            include_str!("scripts/runtime-shared.js"),
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
        let _ = ctx.eval::<(), _>(metadata_js);
        let promise = ctx
            .eval::<Promise, _>("globalThis.__baal_actor_metadata_p")
            .ok();
        let result = promise
            .and_then(|p| p.finish::<String>().ok())
            .unwrap_or_default();
        serde_json::from_str(&result).unwrap_or_default()
    })
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

fn default_max_attempts() -> u32 {
    3
}
fn default_initial_interval_ms() -> u64 {
    1000
}
fn default_backoff_factor() -> f64 {
    2.0
}
fn default_max_interval_ms() -> u64 {
    300_000
}

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

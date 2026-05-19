use rquickjs::{Context, Promise, Runtime};
use std::sync::Arc;

use super::error::{format_js_error, log_js_failure};
use super::module_loader::install_user_module_loader;
use super::modules;
use super::modules::sdk::{SdkCommCtx, set_comm_ctx, clear_comm_ctx};

const QUEUE_WORKER_RUNTIME_JS: &str = concat!(
    include_str!("scripts/runtime-shared.js"),
    "\n",
    include_str!("scripts/queue-worker-runtime.js")
);

const QUEUE_WORKER_METADATA_JS: &str = concat!(
    include_str!("scripts/runtime-shared.js"),
    "\n",
    include_str!("scripts/queue-worker-metadata.js")
);

#[derive(Debug, Clone)]
pub struct QueueWorkerRunContext {
    pub run_id: String,
    pub attempt: u32,
    pub enqueued_at: i64,
    pub data_json: String,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerMetadata {
    pub timeout_ms: Option<u64>,
    pub batch: Option<BatchConfig>,
    pub max_attempts: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct BatchConfig {
    pub size: usize,
    pub timeout_ms: u64,
}

pub fn extract_worker_metadata(source: &str) -> WorkerMetadata {
    let default = WorkerMetadata::default();
    let result_json: Option<String> = (|| {
        let rt = Runtime::new().ok()?;
        install_user_module_loader(&rt, source).ok()?;
        let ctx = Context::full(&rt).ok()?;
        ctx.with(|ctx| -> Option<String> {
            modules::register_all(&ctx).ok()?;
            ctx.eval::<(), _>(QUEUE_WORKER_METADATA_JS).ok()?;
            let promise = ctx
                .eval::<Promise, _>("globalThis.__baal_qw_metadata_p")
                .ok()?;
            promise.finish::<String>().ok()
        })
    })();
    let Some(json_str) = result_json else {
        return default;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) else {
        return default;
    };
    let timeout_ms = val.get("timeoutMs").and_then(|v| v.as_u64());
    let batch = val
        .get("batchJson")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .map(|b| BatchConfig {
            size: b.get("size").and_then(|v| v.as_u64()).unwrap_or(1) as usize,
            timeout_ms: b.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(5000),
        });
    let max_attempts = val.get("maxAttempts").and_then(|v| v.as_u64()).map(|v| v as u32);
    WorkerMetadata { timeout_ms, batch, max_attempts }
}

#[derive(Debug, Clone)]
pub struct QueueWorkerRetryPolicy {
    pub max_attempts: u32,
    pub initial_interval_ms: u64,
    pub backoff_factor: f64,
    pub max_interval_ms: u64,
}

impl Default for QueueWorkerRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_interval_ms: 1000,
            backoff_factor: 2.0,
            max_interval_ms: 300_000,
        }
    }
}

#[derive(Debug, Clone)]
pub enum QueueWorkerRunOutcome {
    Completed(String),
    Failed(String),
    TerminalError(String),
}

#[derive(Debug, Clone)]
pub struct QueueWorkerRunResult {
    pub outcome: QueueWorkerRunOutcome,
    pub retry_policy: QueueWorkerRetryPolicy,
}

pub fn run_worker_handler(
    source: &str,
    run_ctx: &QueueWorkerRunContext,
    comm: Arc<SdkCommCtx>,
) -> Result<QueueWorkerRunResult, String> {
    set_comm_ctx(comm);
    let result = run_worker_handler_inner(source, run_ctx);
    clear_comm_ctx();
    result
}

fn run_worker_handler_inner(
    source: &str,
    run_ctx: &QueueWorkerRunContext,
) -> Result<QueueWorkerRunResult, String> {
    let rt = Runtime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("queue_worker runtime init", &msg);
        msg
    })?;
    install_user_module_loader(&rt, source).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("queue_worker module loader init", &msg);
        msg
    })?;
    let ctx = Context::full(&rt).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("queue_worker context init", &msg);
        msg
    })?;
    ctx.with(|ctx| run_queue_worker_in_ctx(&ctx, source, run_ctx))
}

fn run_queue_worker_in_ctx(
    ctx: &rquickjs::Ctx<'_>,
    source: &str,
    run_ctx: &QueueWorkerRunContext,
) -> Result<QueueWorkerRunResult, String> {
    modules::register_all(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("queue_worker register_globals", &msg);
        msg
    })?;

    modules::register_sdk_comm(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("queue_worker register_sdk_comm", &msg);
        msg
    })?;

    let qw_ctx_json = build_qw_ctx_json(run_ctx);
    let qw_ctx_val = ctx
        .eval::<rquickjs::Value, _>(format!("({})", qw_ctx_json))
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("queue_worker parse_ctx", &msg);
            msg
        })?;

    ctx.globals()
        .set("__baal_qw_ctx", qw_ctx_val)
        .map_err(|e| e.to_string())?;
    ctx.eval::<(), _>(QUEUE_WORKER_RUNTIME_JS).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("queue_worker eval_runtime", &msg);
        msg
    })?;

    let promise: Promise = ctx
        .eval::<Promise, _>("globalThis.__baal_qw_result")
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("queue_worker read_promise", &msg);
            msg
        })?;

    let result_val: rquickjs::Value = promise.finish().map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("queue_worker promise_finish", &msg);
        msg
    })?;

    let result_str: String = result_val
        .as_string()
        .ok_or("queue_worker result is not a string")?
        .to_string()
        .map_err(|e| e.to_string())?;

    parse_queue_worker_result(&result_str)
}

fn build_qw_ctx_json(run_ctx: &QueueWorkerRunContext) -> String {
    let run_id_escaped = run_ctx.run_id.replace('\\', "\\\\").replace('"', "\\\"");
    let data_escaped = serde_json::to_string(&run_ctx.data_json)
        .unwrap_or_else(|_| "\"{}\"".to_string());
    format!(
        r#"{{
  "runId": "{run_id_escaped}",
  "attempt": {attempt},
  "enqueuedAt": {enqueued_at},
  "data": {data_escaped}
}}"#,
        run_id_escaped = run_id_escaped,
        attempt = run_ctx.attempt,
        enqueued_at = run_ctx.enqueued_at,
    )
}

fn parse_queue_worker_result(result_json: &str) -> Result<QueueWorkerRunResult, String> {
    let val: serde_json::Value = serde_json::from_str(result_json)
        .map_err(|e| format!("failed to parse queue_worker result: {e}"))?;

    let retry_policy = extract_retry_policy(&val);

    let result_type = val
        .get("__type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let outcome = match result_type {
        "completed" => {
            let value = val
                .get("value")
                .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()))
                .unwrap_or_else(|| "null".to_string());
            QueueWorkerRunOutcome::Completed(value)
        }
        "terminal_error" => {
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("terminal error")
                .to_string();
            QueueWorkerRunOutcome::TerminalError(error)
        }
        "error" => {
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("queue_worker error")
                .to_string();
            QueueWorkerRunOutcome::Failed(error)
        }
        other => return Err(format!("unknown queue_worker result type: {other}")),
    };

    Ok(QueueWorkerRunResult {
        outcome,
        retry_policy,
    })
}

fn extract_retry_policy(val: &serde_json::Value) -> QueueWorkerRetryPolicy {
    let default = QueueWorkerRetryPolicy::default();
    let Some(retry) = val
        .get("metadata")
        .and_then(|m| m.get("retry"))
    else {
        return default;
    };
    QueueWorkerRetryPolicy {
        max_attempts: retry
            .get("maxAttempts")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(default.max_attempts),
        initial_interval_ms: retry
            .get("initialIntervalMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(default.initial_interval_ms),
        backoff_factor: retry
            .get("backoffFactor")
            .and_then(|v| v.as_f64())
            .unwrap_or(default.backoff_factor),
        max_interval_ms: retry
            .get("maxIntervalMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(default.max_interval_ms),
    }
}

pub fn queue_worker_backoff_delay(policy: &QueueWorkerRetryPolicy, attempt: u32) -> std::time::Duration {
    let delay_ms = (policy.initial_interval_ms as f64
        * policy.backoff_factor.powi((attempt.saturating_sub(1)) as i32))
    .min(policy.max_interval_ms as f64) as u64;
    std::time::Duration::from_millis(delay_ms)
}

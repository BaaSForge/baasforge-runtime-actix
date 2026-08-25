use rquickjs::{AsyncContext, CaughtError};
use std::sync::Arc;
use std::time::Instant;

use crate::services::usage_meter::{self, UnitUsageRecord};

use super::error::log_js_failure;
use super::js_pool;
use super::js_timings;
use super::module_loader::validate_and_prepare_loader;
use super::modules;
use super::modules::sdk::{CommCtxGuard, SdkCommCtx};

const QUEUE_WORKER_RUNTIME_JS: &str = unit_js_runtime!("scripts/queue-worker-runtime.js");

const QUEUE_WORKER_METADATA_JS: &str = unit_js_runtime!("scripts/queue-worker-metadata.js");

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

pub async fn extract_worker_metadata(source: &str) -> WorkerMetadata {
    let result: Option<String> = (async {
        let baal = validate_and_prepare_loader(source, None).ok()?;
        let (llrt_resolver, llrt_loader, attachment) =
            llrt_modules::module_builder::ModuleBuilder::default().build();
        let rt = js_pool::acquire_runtime().await.ok()?;
        rt.set_loader(
            (baal.clone(), llrt_resolver),
            (llrt_loader, baal),
        )
        .await;
        let ctx = AsyncContext::full(&rt).await.ok()?;

        let r = rquickjs::async_with!(ctx => |ctx| {
            attachment.attach(&ctx).ok()?;
            ctx.eval::<(), _>(QUEUE_WORKER_METADATA_JS).ok()?;
            let promise = ctx
                .eval::<rquickjs::Promise, _>("globalThis.__baal_qw_metadata_p")
                .ok()?;
            promise.into_future::<String>().await.ok()
        })
        .await;
        drop(ctx);
        js_pool::release_runtime(rt).await;
        r
    })
    .await;

    let Some(json_str) = result else {
        return WorkerMetadata::default();
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) else {
        return WorkerMetadata::default();
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

pub async fn run_worker_handler_on_blocking_pool(
    source: &str,
    run_ctx: &QueueWorkerRunContext,
    comm: Arc<SdkCommCtx>,
) -> Result<QueueWorkerRunResult, String> {
    let source = source.to_string();
    let run_ctx = run_ctx.clone();
    crate::libs::runtime_bridge::run_async_on_blocking_pool(async move {
        run_worker_handler(&source, &run_ctx, comm).await
    })
    .await
}

pub async fn run_worker_handler(
    source: &str,
    run_ctx: &QueueWorkerRunContext,
    comm: Arc<SdkCommCtx>,
) -> Result<QueueWorkerRunResult, String> {
    crate::rt_enter!(
        "js.qw.run_worker_handler",
        run_id = %run_ctx.run_id,
        attempt = run_ctx.attempt
    );
    let started = Instant::now();
    let project_id = comm.project_id.clone();
    let unit_path = comm.source_unit_path.clone();
    let run_id = run_ctx.run_id.clone();
    let attempt = run_ctx.attempt;
    let memory_mb = comm.usage_meter.queue_worker;

    let execution = async {
    js_timings::reset();
    let baal = validate_and_prepare_loader(source, None).map_err(|e| e.to_string())?;
    let (llrt_resolver, llrt_loader, attachment) =
        llrt_modules::module_builder::ModuleBuilder::default().build();

    let rt = js_pool::acquire_runtime().await.map_err(|e| {
        log_js_failure("queue_worker runtime init", &e);
        e
    })?;

    rt.set_loader(
        (baal.clone(), llrt_resolver),
        (llrt_loader, baal),
    )
    .await;

    let ctx = AsyncContext::full(&rt).await.map_err(|e| {
        let msg = e.to_string();
        log_js_failure("queue_worker context init", &msg);
        msg
    })?;

    let qw_ctx_js = build_qw_ctx_json(run_ctx);

    let result = rquickjs::async_with!(ctx => |ctx| {
        let _guard = CommCtxGuard::install(comm);

        let outcome: Result<QueueWorkerRunResult, String> = async {
            let attach_started = Instant::now();
            super::error::attach_llrt_modules(&ctx, || attachment.attach(&ctx))?;
            js_timings::set_llrt_attach(attach_started.elapsed());

            modules::register_sdk_comm(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            let qw_ctx_val = ctx
                .eval::<rquickjs::Value, _>(format!("({})", qw_ctx_js))
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__baal_qw_ctx", qw_ctx_val)
                .map_err(|e| e.to_string())?;

            let boot_started = Instant::now();
            ctx.eval::<(), _>(QUEUE_WORKER_RUNTIME_JS)
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            js_timings::set_bootstrap_eval(boot_started.elapsed());

            let handler_started = Instant::now();
            let promise: rquickjs::Promise = ctx
                .eval("globalThis.__baal_qw_result")
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            let result_val = promise
                .into_future::<rquickjs::Value>()
                .await
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            js_timings::set_handler_exec(handler_started.elapsed());

            let result_str: String = result_val
                .as_string()
                .ok_or("queue_worker result is not a string")?
                .to_string()
                .map_err(|e| e.to_string())?;

            parse_queue_worker_result(&result_str)
        }
        .await;

        if let Err(ref msg) = outcome {
            log_js_failure("queue_worker run", msg);
        }
        Ok(outcome)
    })
    .await
    .map_err(|e: rquickjs::Error| e.to_string())??;

    drop(ctx);
    js_pool::release_runtime(rt).await;
    js_timings::emit_trace("js.qw.run_worker_handler");

    crate::rt_exit_ok!(
        "js.qw.run_worker_handler",
        run_id = %run_ctx.run_id,
        outcome = ?std::mem::discriminant(&result.outcome)
    );
    Ok(result)
    }
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;
    let outcome = match &execution {
        Ok(r) => match r.outcome {
            QueueWorkerRunOutcome::Completed(_) => "ok",
            QueueWorkerRunOutcome::Failed(_) => "retry",
            QueueWorkerRunOutcome::TerminalError(_) => "failed",
        },
        Err(_) => "error",
    };
    usage_meter::log_unit_usage(UnitUsageRecord {
        project_id,
        unit_type: "queue_worker",
        unit_path,
        trigger: "wq_work",
        duration_ms,
        memory_mb,
        actions: 1,
        outcome,
        instance_id: None,
        run_id: Some(run_id),
        actor_id: None,
        handler: None,
        attempt: Some(attempt),
    });
    execution
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

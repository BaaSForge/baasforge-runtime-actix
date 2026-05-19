use rquickjs::{Context, Promise, Runtime};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::error::{format_js_error, log_js_failure};
use super::module_loader::install_user_module_loader;
use super::modules;
use super::modules::sdk::{self, SdkCommCtx, WorkflowHostCtx};

const WORKFLOW_RUNTIME_JS: &str = concat!(include_str!("scripts/runtime-shared.js"), "\n", include_str!("scripts/workflow-runtime.js"));

/// Context data passed into the QuickJS workflow runtime.
#[derive(Debug, Clone)]
pub struct WorkflowExecutionContext {
    pub project_id: String,
    pub instance_id: String,
    pub input: String,
    /// `step_name` -> JSON of { status, result?, error?, terminal? }
    pub steps: HashMap<String, String>,
    /// `sleep_name` -> JSON of { elapsed }
    pub sleeps: HashMap<String, String>,
    /// `promise_name` -> JSON of { status, value?, error? }
    pub promises: HashMap<String, String>,
    pub date_now: i64,
    /// If `Some`, this is a shared handler invocation (not the main run).
    pub handler_name: Option<String>,
    pub handler_input: Option<String>,
}

/// Result of executing a workflow step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WorkflowExecutionResult {
    Completed(String),
    Suspended {
        suspension_type: String,
        name: String,
        config: serde_json::Value,
    },
    Failed(String),
    HandlerResult(String),
}

/// Run a workflow in QuickJS. Called inside `spawn_blocking`.
pub fn run_workflow_handler(
    source: &str,
    wf_ctx: &WorkflowExecutionContext,
    redis: &Arc<Mutex<redis::aio::MultiplexedConnection>>,
    nats: &Option<async_nats::Client>,
    comm: Arc<SdkCommCtx>,
) -> Result<WorkflowExecutionResult, String> {
    let host_ctx = Arc::new(WorkflowHostCtx {
        redis: redis.clone(),
        nats: nats.clone(),
        project_id: wf_ctx.project_id.clone(),
        instance_id: wf_ctx.instance_id.clone(),
    });
    sdk::set_host_ctx(host_ctx);
    sdk::set_comm_ctx(comm);

    let result = run_workflow_in_quickjs(source, wf_ctx);

    sdk::clear_comm_ctx();
    sdk::clear_host_ctx();
    result
}

fn run_workflow_in_quickjs(
    source: &str,
    wf_ctx: &WorkflowExecutionContext,
) -> Result<WorkflowExecutionResult, String> {
    let rt = Runtime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("workflow runtime init", &msg);
        msg
    })?;
    install_user_module_loader(&rt, source).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("workflow module loader init", &msg);
        msg
    })?;
    let ctx = Context::full(&rt).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("workflow context init", &msg);
        msg
    })?;
    ctx.with(|ctx| run_workflow_in_ctx(&ctx, source, wf_ctx))
}

fn run_workflow_in_ctx(
    ctx: &rquickjs::Ctx<'_>,
    source: &str,
    wf_ctx: &WorkflowExecutionContext,
) -> Result<WorkflowExecutionResult, String> {
    modules::register_all(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("workflow register_globals", &msg);
        msg
    })?;

    modules::register_sdk_comm(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("workflow register_sdk_comm", &msg);
        msg
    })?;

    modules::register_workflow_sdk(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("workflow register_sdk", &msg);
        msg
    })?;

    // Build the __baal_workflow_ctx JS object
    let wf_ctx_json = build_workflow_ctx_json(wf_ctx);
    let wf_ctx_val = ctx
        .eval::<rquickjs::Value, _>(format!("({})", wf_ctx_json))
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("workflow parse ctx", &msg);
            msg
        })?;
    ctx.globals()
        .set("__baal_workflow_ctx", wf_ctx_val)
        .map_err(|e| e.to_string())?;
    ctx.eval::<(), _>(WORKFLOW_RUNTIME_JS).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("workflow eval_setup", &msg);
        msg
    })?;

    let promise: Promise = ctx
        .eval::<Promise, _>("globalThis.__baal_wf_result")
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("workflow read_promise", &msg);
            msg
        })?;

    let result_val: rquickjs::Value = promise.finish().map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("workflow promise", &msg);
        msg
    })?;

    let result_str: String = result_val
        .as_string()
        .ok_or("workflow result is not a string")?
        .to_string()
        .map_err(|e| e.to_string())?;

    parse_workflow_result(&result_str)
}

fn build_workflow_ctx_json(wf_ctx: &WorkflowExecutionContext) -> String {
    let input_escaped = serde_json::to_string(&wf_ctx.input).unwrap_or_else(|_| "\"\"".to_string());
    let handler_name = match &wf_ctx.handler_name {
        Some(n) => format!("\"{}\"", n.replace('\\', "\\\\").replace('"', "\\\"")),
        None => "null".to_string(),
    };
    let handler_input = match &wf_ctx.handler_input {
        Some(i) => serde_json::to_string(i).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };

    // The steps/sleeps/promises are stored as JSON strings in the HashMap values.
    // We need to parse them into actual objects for JS consumption.
    let steps_obj = build_parsed_map_json(&wf_ctx.steps);
    let sleeps_obj = build_parsed_map_json(&wf_ctx.sleeps);
    let promises_obj = build_parsed_map_json(&wf_ctx.promises);

    format!(
        r#"({{
  "__instanceId": "{}",
  "__input": {},
  "__steps": {},
  "__sleeps": {},
  "__promises": {},
  "__dateNow": {},
  "__stepIndex": 0,
  "__handlerName": {},
  "__handlerInput": {}
}})"#,
        wf_ctx.instance_id.replace('\\', "\\\\").replace('"', "\\\""),
        input_escaped,
        steps_obj,
        sleeps_obj,
        promises_obj,
        wf_ctx.date_now,
        handler_name,
        handler_input,
    )
}

/// Build a JSON object string where each value is a parsed JSON object (not a string).
fn build_parsed_map_json(map: &HashMap<String, String>) -> String {
    if map.is_empty() {
        return "{}".to_string();
    }
    let mut parts = Vec::new();
    for (k, v) in map {
        let key = k.replace('\\', "\\\\").replace('"', "\\\"");
        // v is already a JSON string, embed it directly
        parts.push(format!("\"{key}\": {v}"));
    }
    format!("{{{}}}", parts.join(", "))
}

fn parse_workflow_result(result_json: &str) -> Result<WorkflowExecutionResult, String> {
    let val: serde_json::Value = serde_json::from_str(result_json)
        .map_err(|e| format!("failed to parse workflow result: {e}"))?;

    let result_type = val
        .get("__type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    match result_type {
        "completed" => {
            let value = val
                .get("value")
                .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()))
                .unwrap_or_else(|| "null".to_string());
            Ok(WorkflowExecutionResult::Completed(value))
        }
        "suspended" => {
            let suspension_type = val
                .get("suspensionType")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let config = val.get("config").cloned().unwrap_or(serde_json::json!({}));
            Ok(WorkflowExecutionResult::Suspended {
                suspension_type,
                name,
                config,
            })
        }
        "terminal_error" => {
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("terminal error")
                .to_string();
            Ok(WorkflowExecutionResult::Failed(error))
        }
        "error" => {
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("workflow error")
                .to_string();
            Ok(WorkflowExecutionResult::Failed(error))
        }
        "handler_result" => {
            let value = val
                .get("value")
                .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()))
                .unwrap_or_else(|| "null".to_string());
            Ok(WorkflowExecutionResult::HandlerResult(value))
        }
        "handler_error" => {
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("handler error")
                .to_string();
            Ok(WorkflowExecutionResult::Failed(error))
        }
        _ => Err(format!("unknown workflow result type: {result_type}")),
    }
}

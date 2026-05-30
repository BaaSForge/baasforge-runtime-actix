use rquickjs::{AsyncContext, AsyncRuntime, CaughtError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::error::log_js_failure;
use super::module_loader::validate_and_prepare_loader;
use super::modules;
use super::modules::sdk::{CommCtxGuard, HostCtxGuard, SdkCommCtx, WorkflowHostCtx};

const WORKFLOW_RUNTIME_JS: &str = unit_js_runtime!("scripts/workflow-runtime.js");

#[derive(Debug, Clone)]
pub struct WorkflowExecutionContext {
    pub project_id: String,
    pub instance_id: String,
    pub input: String,
    pub steps: HashMap<String, String>,
    pub sleeps: HashMap<String, String>,
    pub promises: HashMap<String, String>,
    pub date_now: i64,
    pub handler_name: Option<String>,
    pub handler_input: Option<String>,
}

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

pub async fn run_workflow_handler(
    source: &str,
    wf_ctx: &WorkflowExecutionContext,
    redis: &Arc<Mutex<redis::aio::MultiplexedConnection>>,
    nats: &Option<async_nats::Client>,
    comm: Arc<SdkCommCtx>,
) -> Result<WorkflowExecutionResult, String> {
    crate::rt_enter!(
        "js.wf.run_workflow_handler",
        instance_id = %wf_ctx.instance_id,
        handler = wf_ctx.handler_name.as_deref().unwrap_or("")
    );
    let host_ctx = Arc::new(WorkflowHostCtx {
        redis: redis.clone(),
        nats: nats.clone(),
        project_id: wf_ctx.project_id.clone(),
        instance_id: wf_ctx.instance_id.clone(),
    });

    let baal = validate_and_prepare_loader(source, None).map_err(|e| e.to_string())?;
    let (llrt_resolver, llrt_loader, attachment) =
        llrt_modules::module_builder::ModuleBuilder::default().build();

    let rt = AsyncRuntime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("workflow runtime init", &msg);
        msg
    })?;

    rt.set_loader(
        (baal.clone(), llrt_resolver),
        (llrt_loader, baal),
    )
    .await;

    let ctx = AsyncContext::full(&rt).await.map_err(|e| {
        let msg = e.to_string();
        log_js_failure("workflow context init", &msg);
        msg
    })?;

    let wf_ctx_js = build_workflow_ctx_json(wf_ctx);

    let result = rquickjs::async_with!(ctx => |ctx| {
        let _hguard = HostCtxGuard::install(host_ctx);
        let _cguard = CommCtxGuard::install(comm);

        let outcome: Result<WorkflowExecutionResult, String> = async {
            attachment.attach(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            modules::register_sdk_comm(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            modules::register_workflow_sdk(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            let wf_ctx_val = ctx
                .eval::<rquickjs::Value, _>(format!("({})", wf_ctx_js))
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__baal_workflow_ctx", wf_ctx_val)
                .map_err(|e| e.to_string())?;

            ctx.eval::<(), _>(WORKFLOW_RUNTIME_JS)
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let promise: rquickjs::Promise = ctx
                .eval("globalThis.__baal_wf_result")
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            let result_val = promise
                .into_future::<rquickjs::Value>()
                .await
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let result_str: String = result_val
                .as_string()
                .ok_or("workflow result is not a string")?
                .to_string()
                .map_err(|e| e.to_string())?;

            parse_workflow_result(&result_str)
        }
        .await;

        if let Err(ref msg) = outcome {
            log_js_failure("workflow run", msg);
        }
        Ok(outcome)
    })
    .await
    .map_err(|e: rquickjs::Error| e.to_string())??;

    drop(ctx);
    rt.idle().await;
    rt.run_gc().await;

    crate::rt_exit_ok!(
        "js.wf.run_workflow_handler",
        instance_id = %wf_ctx.instance_id,
        outcome = ?std::mem::discriminant(&result)
    );
    Ok(result)
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

fn build_parsed_map_json(map: &HashMap<String, String>) -> String {
    if map.is_empty() {
        return "{}".to_string();
    }
    let mut parts = Vec::new();
    for (k, v) in map {
        let key = k.replace('\\', "\\\\").replace('"', "\\\"");
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

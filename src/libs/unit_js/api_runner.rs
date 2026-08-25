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
use super::types::{JsResponseRaw, TriggerHttpResponse, TriggerHttpSnapshot};

const API_RUNTIME_JS: &str = unit_js_runtime!("scripts/api-runtime.js");

pub async fn run_unit_handler(
    source: &str,
    snapshot: &TriggerHttpSnapshot,
    comm: Option<Arc<SdkCommCtx>>,
    unit_path: Option<&str>,
) -> Result<TriggerHttpResponse, String> {
    crate::rt_enter!(
        "js.api.run_unit_handler",
        unit_path = unit_path.unwrap_or(""),
        method = %snapshot.method,
        trigger_path = %snapshot.trigger_path,
        body_bytes = snapshot.body_text.len()
    );
    let started = Instant::now();
    let project_id = comm.as_ref().map(|c| c.project_id.clone()).unwrap_or_default();
    let project_id_for_js = project_id.clone();
    let unit_path_str = unit_path.unwrap_or("").to_string();
    let memory_mb = comm.as_ref().map(|c| c.usage_meter.api).unwrap_or(0);

    let execution = async {
    js_timings::reset();
    let unit_entry_dir = unit_path
        .and_then(|p| p.rsplit_once('/').map(|(dir, _)| dir.to_string()));
    let baal = validate_and_prepare_loader(source, unit_entry_dir).map_err(|e| e.to_string())?;

    let (llrt_resolver, llrt_loader, attachment) =
        llrt_modules::module_builder::ModuleBuilder::default().build();

    let rt = js_pool::acquire_runtime().await.map_err(|e| {
        log_js_failure("api runtime init", &e);
        e
    })?;

    rt.set_loader(
        (baal.clone(), llrt_resolver),
        (llrt_loader, baal),
    )
    .await;

    let ctx = AsyncContext::full(&rt).await.map_err(|e| {
        let msg = e.to_string();
        log_js_failure("api context init", &msg);
        msg
    })?;

    let self_host = snapshot
        .header_pairs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "localhost".to_string());
    let trigger_path = snapshot.trigger_path.clone();
    let snapshot_json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;

    let result = rquickjs::async_with!(ctx => |ctx| {
        let _comm_guard = comm.map(CommCtxGuard::install);

        let outcome: Result<TriggerHttpResponse, String> = async {
            let attach_started = Instant::now();
            super::error::attach_llrt_modules(&ctx, || attachment.attach(&ctx))?;
            js_timings::set_llrt_attach(attach_started.elapsed());

            modules::register_sdk_comm(&ctx).map_err(|e| {
                format!("sdk.register: {}", CaughtError::from_error(&ctx, e))
            })?;

            ctx.globals()
                .set("__triggerBasePath", trigger_path.as_str())
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__selfHost", self_host.as_str())
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__baal_project_id", project_id_for_js.as_str())
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.eval::<(), _>(format!("globalThis.__snap = {};", snapshot_json))
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let boot_started = Instant::now();
            ctx.eval::<(), _>(API_RUNTIME_JS)
                .map_err(|e| format!("bootstrap.eval: {}", CaughtError::from_error(&ctx, e)))?;
            js_timings::set_bootstrap_eval(boot_started.elapsed());

            let handler_started = Instant::now();
            let promise: rquickjs::Promise = ctx
                .eval("globalThis.__baal_p")
                .map_err(|e| format!("bootstrap.promise: {}", CaughtError::from_error(&ctx, e)))?;
            promise
                .into_future::<()>()
                .await
                .map_err(|e| format!("handler: {}", CaughtError::from_error(&ctx, e)))?;
            js_timings::set_handler_exec(handler_started.elapsed());

            let json_str: String = ctx
                .eval("JSON.stringify(globalThis.__baal_res.__snapshot())")
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let raw: JsResponseRaw =
                serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
            Ok(raw.into())
        }
        .await;

        if let Err(ref msg) = outcome {
            log_js_failure("api run", msg);
        }
        Ok(outcome)
    })
    .await
    .map_err(|e: rquickjs::Error| e.to_string())??;

    drop(ctx);
    js_pool::release_runtime(rt).await;
    js_timings::emit_trace("js.api.run_unit_handler");

    crate::rt_exit_ok!(
        "js.api.run_unit_handler",
        unit_path = unit_path.unwrap_or(""),
        status = result.status,
        body_bytes = result.body.len()
    );
    Ok(result)
    }
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;
    usage_meter::log_unit_usage(UnitUsageRecord {
        project_id,
        unit_type: "api",
        unit_path: unit_path_str,
        trigger: "http",
        duration_ms,
        memory_mb,
        actions: 1,
        outcome: if execution.is_ok() { "ok" } else { "error" },
        instance_id: None,
        run_id: None,
        actor_id: None,
        handler: None,
        attempt: None,
    });
    execution
}

pub async fn import_entry_module_for_meta(
    source: &str,
    meta_js: &str,
    result_global: &str,
) -> Option<String> {
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
    let result_global = result_global.to_string();
    let meta_js = meta_js.to_string();

    let result = rquickjs::async_with!(ctx => |ctx| {
        attachment.attach(&ctx).ok()?;
        ctx.eval::<(), _>(meta_js.as_str()).ok()?;
        let promise = ctx
            .eval::<rquickjs::Promise, _>(format!("globalThis.{result_global}"))
            .ok()?;
        promise.into_future::<String>().await.ok()
    })
    .await;
    drop(ctx);
    js_pool::release_runtime(rt).await;
    result
}

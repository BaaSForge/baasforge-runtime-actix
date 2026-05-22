use rquickjs::{AsyncContext, AsyncRuntime, CaughtError};
use std::sync::Arc;

use super::error::log_js_failure;
use super::module_loader::validate_and_prepare_loader;
use super::modules;
use super::modules::sdk::{CommCtxGuard, SdkCommCtx};
use super::types::{JsResponseRaw, TriggerHttpResponse, TriggerHttpSnapshot};

const API_RUNTIME_JS: &str = concat!(
    include_str!("scripts/runtime-shared.js"),
    "\n",
    include_str!("scripts/platform-patches.js"),
    "\n",
    include_str!("scripts/api-runtime.js")
);

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
    let unit_entry_dir = unit_path
        .and_then(|p| p.rsplit_once('/').map(|(dir, _)| dir.to_string()));
    let baal = validate_and_prepare_loader(source, unit_entry_dir).map_err(|e| e.to_string())?;

    let (llrt_resolver, llrt_loader, attachment) =
        llrt_modules::module_builder::ModuleBuilder::default().build();

    let rt = AsyncRuntime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("api runtime init", &msg);
        msg
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
    let project_id = comm.as_ref().map(|c| c.project_id.clone()).unwrap_or_default();
    let trigger_path = snapshot.trigger_path.clone();
    let snapshot_json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;

    let result = rquickjs::async_with!(ctx => |ctx| {
        let _comm_guard = comm.map(CommCtxGuard::install);

        let outcome: Result<TriggerHttpResponse, String> = async {
            attachment.attach(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            modules::register_sdk_comm(&ctx).map_err(|e| {
                CaughtError::from_error(&ctx, e).to_string()
            })?;

            ctx.globals()
                .set("__triggerBasePath", trigger_path.as_str())
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__selfHost", self_host.as_str())
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.globals()
                .set("__baal_project_id", project_id.as_str())
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            ctx.eval::<(), _>(format!("globalThis.__snap = {};", snapshot_json))
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            ctx.eval::<(), _>(API_RUNTIME_JS)
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

            let promise: rquickjs::Promise = ctx
                .eval("globalThis.__baal_p")
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;
            promise
                .into_future::<()>()
                .await
                .map_err(|e| CaughtError::from_error(&ctx, e).to_string())?;

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
    rt.idle().await;
    rt.run_gc().await;

    crate::rt_exit_ok!(
        "js.api.run_unit_handler",
        unit_path = unit_path.unwrap_or(""),
        status = result.status,
        body_bytes = result.body.len()
    );
    Ok(result)
}

pub async fn import_entry_module_for_meta(
    source: &str,
    meta_js: &str,
    result_global: &str,
) -> Option<String> {
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
    rt.idle().await;
    rt.run_gc().await;
    result
}

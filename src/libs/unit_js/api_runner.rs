use rquickjs::{Context, Ctx, Promise, Runtime, Value};
use std::sync::Arc;

use super::error::{format_js_error, log_js_failure};
use super::modules;
use super::modules::sdk::{SdkCommCtx, set_comm_ctx, clear_comm_ctx};
use super::types::{JsResponseRaw, TriggerHttpResponse, TriggerHttpSnapshot};

fn register_globals(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    modules::register_all(ctx)?;
    rquickjs_extra_console::init(ctx)?;
    Ok(())
}

const API_RUNTIME_JS: &str = concat!(include_str!("scripts/runtime-shared.js"), "\n", include_str!("scripts/api-runtime.js"));

pub fn run_unit_handler(
    source: &str,
    snapshot: &TriggerHttpSnapshot,
    comm: Option<Arc<SdkCommCtx>>,
) -> Result<TriggerHttpResponse, String> {
    if let Some(c) = comm {
        set_comm_ctx(c);
    }
    let rt = Runtime::new().map_err(|e| {
        let msg = e.to_string();
        log_js_failure("runtime init", &msg);
        msg
    })?;
    let ctx = Context::full(&rt).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("context init", &msg);
        msg
    })?;
    let result = ctx.with(|ctx| run_in_ctx(&ctx, source, snapshot));
    clear_comm_ctx();
    result
}

fn run_in_ctx(
    ctx: &Ctx<'_>,
    source: &str,
    snapshot: &TriggerHttpSnapshot,
) -> Result<TriggerHttpResponse, String> {
    // Expose trigger path + host before module registration so fetch.js
    // can rewrite self-referencing URLs to the correct trigger endpoint.
    let self_host = snapshot
        .header_pairs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("localhost");

    ctx.globals()
        .set("__triggerBasePath", snapshot.trigger_path.as_str())
        .map_err(|e| e.to_string())?;
    ctx.globals()
        .set("__selfHost", self_host)
        .map_err(|e| e.to_string())?;

    register_globals(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("register_globals", &msg);
        msg
    })?;

    modules::register_sdk_comm(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("api register_sdk_comm", &msg);
        msg
    })?;

    let snap_val = rquickjs_serde::to_value(ctx.clone(), snapshot).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("serialize_snapshot", &msg);
        msg
    })?;
    ctx.globals()
        .set("__snap", snap_val)
        .map_err(|e| e.to_string())?;
    ctx.globals()
        .set("__userSource", source)
        .map_err(|e| e.to_string())?;

    ctx.eval::<(), _>(API_RUNTIME_JS).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("eval_setup", &msg);
        msg
    })?;

    let promise: Promise = ctx.eval::<Promise, _>("globalThis.__baal_p").map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("read_promise", &msg);
        msg
    })?;

    promise.finish::<()>().map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("promise", &msg);
        msg
    })?;

    let res_val: Value = ctx
        .eval("globalThis.__baal_res.__snapshot()")
        .map_err(|e| {
            let msg = format_js_error(ctx, e);
            log_js_failure("read_res", &msg);
            msg
        })?;

    let raw: JsResponseRaw = rquickjs_serde::from_value(res_val).map_err(|e| {
        let msg = e.to_string();
        log_js_failure("deserialize_res", &msg);
        msg
    })?;

    Ok(raw.into())
}

use rquickjs::{Context, Ctx, Promise, Runtime, Value};

use super::error::{format_js_error, log_js_failure};
use super::types::{JsResponseRaw, TriggerHttpResponse, TriggerHttpSnapshot};
use super::url;

fn register_globals(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    url::register(ctx)?;
    rquickjs_extra_console::init(ctx)?;
    Ok(())
}

const RUNTIME_JS: &str = include_str!("scripts/runtime.js");

pub fn run_unit_handler(
    source: &str,
    snapshot: &TriggerHttpSnapshot,
) -> Result<TriggerHttpResponse, String> {
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
    ctx.with(|ctx| run_in_ctx(&ctx, source, snapshot))
}

fn run_in_ctx(
    ctx: &Ctx<'_>,
    source: &str,
    snapshot: &TriggerHttpSnapshot,
) -> Result<TriggerHttpResponse, String> {
    register_globals(ctx).map_err(|e| {
        let msg = format_js_error(ctx, e);
        log_js_failure("register_globals", &msg);
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

    ctx.eval::<(), _>(RUNTIME_JS).map_err(|e| {
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

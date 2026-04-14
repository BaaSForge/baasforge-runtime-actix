use rquickjs::{Ctx, function::Func};

const POLYFILLS_JS: &str = include_str!("../scripts/polyfills.js");

/// Synchronous OS-thread sleep exposed to QuickJS as `__baal_sleep_sync(ms)`.
///
/// QuickJS has no real async event loop, so blocking the OS thread is the only
/// way to introduce a genuine wall-clock delay within a JavaScript execution.
///
/// The JavaScript polyfill layer caps the incoming value before calling here
/// (`__BAAL_MAX_SLEEP_MS` for setTimeout, `__BAAL_IV_MAX_TICK_MS` for setInterval),
/// so this function trusts the JS-side cap and simply sleeps for `ms`.
///
/// Workflow code must use `ctx.sleep()` for durable delays — that suspends the
/// entire workflow instance via JetStream and never calls this function.
fn host_sleep_sync(_ctx: Ctx<'_>, ms: f64) -> rquickjs::Result<()> {
    if ms > 0.0 {
        std::thread::sleep(std::time::Duration::from_millis(ms as u64));
    }
    Ok(())
}

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__baal_sleep_sync", Func::from(host_sleep_sync))?;
    ctx.eval::<(), _>(POLYFILLS_JS)?;
    Ok(())
}

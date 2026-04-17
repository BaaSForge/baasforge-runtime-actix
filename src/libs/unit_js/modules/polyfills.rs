use rquickjs::{Ctx, function::Func};
use std::cell::Cell;
use std::time::Instant;

const POLYFILLS_JS: &str = include_str!("../scripts/polyfills.js");

thread_local! {
    pub static EXECUTION_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

fn host_sleep_sync(ctx: Ctx<'_>, ms: f64) -> rquickjs::Result<()> {
    if ms > 0.0 {
        let requested = std::time::Duration::from_millis(ms as u64);
        let actual = EXECUTION_DEADLINE.with(|d| {
            if let Some(deadline) = d.get() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                requested.min(remaining)
            } else {
                requested
            }
        });
        if !actual.is_zero() {
            std::thread::sleep(actual);
        }
        let expired = EXECUTION_DEADLINE.with(|d| {
            d.get().map_or(false, |dl| Instant::now() >= dl)
        });
        if expired {
            let exc: rquickjs::Value = ctx.eval("new Error('actor timeout expired')")?;
            return Err(ctx.throw(exc));
        }
    }
    Ok(())
}

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__baal_sleep_sync", Func::from(host_sleep_sync))?;
    ctx.eval::<(), _>(POLYFILLS_JS)?;
    Ok(())
}

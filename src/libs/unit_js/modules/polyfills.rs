use rquickjs::{Ctx, function::Func};

const POLYFILLS_JS: &str = include_str!("../scripts/polyfills.js");

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

use rquickjs::Ctx;

const POLYFILLS_JS: &str = include_str!("../scripts/polyfills.js");

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(POLYFILLS_JS)?;
    Ok(())
}

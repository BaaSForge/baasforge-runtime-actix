mod base64;
mod buffer;
mod crypto;
mod encoding;
mod fetch;
pub(crate) mod helpers;
mod polyfills;
mod structured_clone;
mod url;

pub fn register_all(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    url::register(ctx)?;
    structured_clone::register(ctx)?;
    base64::register(ctx)?;
    encoding::register(ctx)?;
    buffer::register(ctx)?;
    crypto::register(ctx)?;
    polyfills::register(ctx)?;
    fetch::register(ctx)?;
    Ok(())
}

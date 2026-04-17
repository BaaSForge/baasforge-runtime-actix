mod base64;
mod buffer;
mod crypto;
mod encoding;
mod fetch;
pub(crate) mod helpers;
pub(crate) mod polyfills;
pub mod sdk;
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

/// Registers cross-unit communication host functions (`__baal_call_actor_sync`, etc.)
/// for all unit types that need them. Reads from `SdkCommCtx` thread-local set by the runner.
pub fn register_sdk_comm(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    sdk::register_sdk_comm(ctx)?;
    Ok(())
}

/// Registers workflow-specific persistence host functions (`__baal_persist_step`, etc.).
/// Only called for workflow units, in addition to `register_sdk_comm`.
pub fn register_workflow_sdk(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    sdk::register_workflow_persistence(ctx)?;
    Ok(())
}

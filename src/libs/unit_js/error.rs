use rquickjs::{CaughtError, Ctx, Error};

pub fn format_js_error(ctx: &Ctx<'_>, err: Error) -> String {
    CaughtError::from_error(ctx, err).to_string()
}

/// LLRT `ModuleBuilder::attach` redefines host globals. On a pooled runtime the
/// second context can throw "property is not configurable"; globals are already there.
pub fn attach_llrt_modules(
    ctx: &Ctx<'_>,
    attach: impl FnOnce() -> rquickjs::Result<()>,
) -> Result<(), String> {
    match attach() {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = CaughtError::from_error(ctx, e).to_string();
            if msg.to_ascii_lowercase().contains("not configurable") {
                Ok(())
            } else {
                Err(format!("llrt.attach: {msg}"))
            }
        }
    }
}

pub fn log_js_failure(phase: &'static str, message: &str) {
    tracing::error!(target: "baal_runtime::unit_js", phase, %message, "QuickJS error");
    eprintln!("[baal_runtime::unit_js] {phase}: {message}");
}

use rquickjs::{CaughtError, Ctx, Error};

pub fn format_js_error(ctx: &Ctx<'_>, err: Error) -> String {
    CaughtError::from_error(ctx, err).to_string()
}

pub fn log_js_failure(phase: &'static str, message: &str) {
    tracing::error!(target: "baal_runtime::unit_js", phase, %message, "QuickJS error");
    eprintln!("[baal_runtime::unit_js] {phase}: {message}");
}

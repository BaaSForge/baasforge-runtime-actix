//! In-process QuickJS ES-module bytecode cache (`Module::write` / `Module::load`).
//!
//! Opt-in via `BAAL_JS_BYTECODE=1` (default off).

use rquickjs::{Ctx, Module, Result as JsResult, WriteOptions};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::module_shims;

const MAX_CACHE_ENTRIES: usize = 8192;

fn bytecode_enabled() -> bool {
    match std::env::var("BAAL_JS_BYTECODE") {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

fn cache() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn cache_key(name: &str, source: &str) -> String {
    let mut buf = Vec::with_capacity(1 + name.len() + source.len());
    buf.extend_from_slice(name.as_bytes());
    buf.push(0);
    buf.extend_from_slice(source.as_bytes());
    sha256_hex(&buf)
}

fn lookup(key: &str) -> Option<Vec<u8>> {
    cache().lock().ok()?.get(key).cloned()
}

fn store(key: String, bytes: Vec<u8>) {
    let Ok(mut guard) = cache().lock() else {
        return;
    };
    if guard.len() >= MAX_CACHE_ENTRIES && !guard.contains_key(&key) {
        return;
    }
    guard.insert(key, bytes);
}

/// Declare a module, using cached bytecode when `BAAL_JS_BYTECODE` is on.
pub fn declare_module<'js>(ctx: &Ctx<'js>, name: &str, source: &str) -> JsResult<Module<'js>> {
    if !bytecode_enabled() {
        return Module::declare(ctx.clone(), name, source.as_bytes());
    }

    let key = cache_key(name, source);
    if let Some(bytes) = lookup(&key) {
        match unsafe { Module::load(ctx.clone(), bytes.as_ref()) } {
            Ok(module) => return Ok(module),
            Err(err) => {
                tracing::warn!(
                    target: "js.bytecode",
                    specifier = name,
                    error = %err,
                    "bytecode load failed; falling back to source"
                );
            }
        }
    }

    let module = Module::declare(ctx.clone(), name, source.as_bytes())?;
    if let Ok(bytes) = module.write(WriteOptions::default()) {
        store(key, bytes);
    }
    Ok(module)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};

    #[test]
    fn es_module_bytecode_roundtrip_exports_match_source() {
        let src = "export const answer = 40 + 2;\nexport default answer;\n";

        let source_answer = eval_export_answer(src, false);
        let bytecode_answer = eval_export_answer(src, true);
        assert_eq!(source_answer, 42);
        assert_eq!(bytecode_answer, 42);
        assert_eq!(source_answer, bytecode_answer);
    }

    fn eval_export_answer(src: &str, via_bytecode: bool) -> i32 {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        // Do not call Runtime::execute_pending_job while Context::with is held;
        // that deadlocks rquickjs. This fixture has no top-level await.
        ctx.with(|ctx| {
            let declared =
                Module::declare(ctx.clone(), "spike.js", src.as_bytes()).expect("declare");
            let module = if via_bytecode {
                let bytes = declared.write(WriteOptions::default()).expect("write");
                assert!(!bytes.is_empty(), "bytecode must be non-empty");
                unsafe { Module::load(ctx.clone(), &bytes) }.expect("load")
            } else {
                declared
            };
            let (evaluated, promise) = module.eval().expect("eval");
            let _ = promise.result::<rquickjs::Value>();
            let ns = evaluated.namespace().expect("namespace");
            ns.get::<_, i32>("answer").expect("export answer")
        })
    }

    #[test]
    fn every_static_shim_declares_and_writes_bytecode() {
        let started = std::time::Instant::now();
        let entries = module_shims::static_shim_entries();
        let mut declare_failures = Vec::new();
        let mut write_failures = Vec::new();

        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            for (name, src) in &entries {
                match Module::declare(ctx.clone(), *name, src.as_bytes()) {
                    Ok(module) => match module.write(WriteOptions::default()) {
                        Ok(bytes) if !bytes.is_empty() => {}
                        Ok(_) => write_failures.push(format!("{name}: empty bytecode")),
                        Err(err) => write_failures.push(format!("{name}: {err}")),
                    },
                    Err(err) => declare_failures.push(format!("{name}: {err}")),
                }
            }
        });

        // `__baal_ext_crypto` re-exports LLRT `node:crypto`; declare without that
        // native module fails. The loader attaches it on real invokes.
        assert!(
            declare_failures
                .iter()
                .all(|f| f.starts_with("__baal_ext_crypto:")),
            "unexpected Module::declare failures: {declare_failures:?}"
        );
        assert!(
            write_failures.is_empty(),
            "Module::write failed for {} shims: {write_failures:?}",
            write_failures.len()
        );
        assert!(
            started.elapsed().as_secs() < 30,
            "compiling all static shims took {:?}",
            started.elapsed()
        );
    }
}

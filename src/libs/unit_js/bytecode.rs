//! QuickJS ES-module bytecode cache (rquickjs 0.11 `Module::write` / `Module::load`).
//!
//! Bytecode is engine-build specific; keys include [`super::js_flags::engine_id`].
//! L1 is an in-process map. L2 is optional Redis (`jsbc:{engine}:{sha256}`) when
//! `REDIS_URL` is set — content-addressed, so deploys of new source miss naturally.

use rquickjs::{Ctx, Module, Result as JsResult, WriteOptions};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::js_flags;
use super::js_timings;
use super::module_shims;

const MAX_CACHE_ENTRIES: usize = 512;

fn cache() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn cache_key(name: &str, source: &str) -> String {
    let mut buf = Vec::with_capacity(64 + name.len() + source.len());
    buf.extend_from_slice(js_flags::engine_id().as_bytes());
    buf.push(0);
    buf.extend_from_slice(name.as_bytes());
    buf.push(0);
    buf.extend_from_slice(source.as_bytes());
    sha256_hex(&buf)
}

fn redis_key(key: &str) -> String {
    format!("jsbc:{}:{key}", js_flags::engine_id())
}

fn l1_get(key: &str) -> Option<Vec<u8>> {
    cache().lock().ok()?.get(key).cloned()
}

fn l1_put(key: String, bytes: Vec<u8>) {
    let Ok(mut guard) = cache().lock() else {
        return;
    };
    if guard.len() >= MAX_CACHE_ENTRIES {
        guard.clear();
    }
    guard.insert(key, bytes);
}

fn l2_get(key: &str) -> Option<Vec<u8>> {
    let url = std::env::var("REDIS_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mut conn = client.get_connection().ok()?;
    redis::cmd("GET")
        .arg(redis_key(key))
        .query::<Option<Vec<u8>>>(&mut conn)
        .ok()
        .flatten()
}

fn l2_put(key: &str, bytes: &[u8]) {
    let Ok(url) = std::env::var("REDIS_URL") else {
        return;
    };
    let Ok(client) = redis::Client::open(url) else {
        return;
    };
    let Ok(mut conn) = client.get_connection() else {
        return;
    };
    let _: Result<(), _> = redis::cmd("SET")
        .arg(redis_key(key))
        .arg(bytes)
        .query(&mut conn);
}

pub fn clear() {
    if let Ok(mut guard) = cache().lock() {
        guard.clear();
    }
}

fn lookup(key: &str) -> Option<Vec<u8>> {
    if let Some(bytes) = l1_get(key) {
        return Some(bytes);
    }
    let bytes = l2_get(key)?;
    l1_put(key.to_string(), bytes.clone());
    Some(bytes)
}

fn store(key: String, bytes: Vec<u8>) {
    l2_put(&key, &bytes);
    l1_put(key, bytes);
}

/// Declare a module, using cached bytecode when [`js_flags::bytecode_enabled`].
pub fn declare_module<'js>(ctx: &Ctx<'js>, name: &str, source: &str) -> JsResult<Module<'js>> {
    if !js_flags::bytecode_enabled() {
        return Module::declare(ctx.clone(), name, source.as_bytes());
    }

    let key = cache_key(name, source);
    if let Some(bytes) = lookup(&key) {
        match unsafe { Module::load(ctx.clone(), bytes.as_ref()) } {
            Ok(module) => {
                js_timings::record_bytecode_hit();
                return Ok(module);
            }
            Err(err) => {
                tracing::warn!(
                    target: "js.cold_start",
                    specifier = name,
                    error = %err,
                    "bytecode load failed; falling back to source"
                );
            }
        }
    }

    js_timings::record_bytecode_miss();
    let module = Module::declare(ctx.clone(), name, source.as_bytes())?;
    match module.write(WriteOptions::default()) {
        Ok(bytes) => store(key, bytes),
        Err(err) => {
            tracing::debug!(
                target: "js.cold_start",
                specifier = name,
                error = %err,
                "module bytecode write skipped"
            );
        }
    }
    Ok(module)
}

/// Compile well-known shims once so the first user invoke is a bytecode hit.
pub fn precompile_static_shims() {
    if !js_flags::bytecode_enabled() {
        return;
    }
    let Ok(rt) = rquickjs::Runtime::new() else {
        return;
    };
    let Ok(ctx) = rquickjs::Context::full(&rt) else {
        return;
    };
    let _ = ctx.with(|ctx| {
        for (name, src) in module_shims::static_shim_entries() {
            let _ = declare_module(&ctx, name, src);
        }
        Ok::<_, rquickjs::Error>(())
    });
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
}

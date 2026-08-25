//! Warm `AsyncRuntime` pool. Each request still gets a new `AsyncContext`.
//!
//! Isolation: never reuse a context that has already run user code.
//! A runtime that already had LLRT modules attached is **not** recycled —
//! attach is not idempotent across contexts (`TextEncoder` / host globals).
//! The pool is refilled with brand-new runtimes instead.

use rquickjs::AsyncRuntime;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use super::js_flags;
use super::js_timings;

fn pool() -> &'static Mutex<Vec<AsyncRuntime>> {
    static POOL: OnceLock<Mutex<Vec<AsyncRuntime>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Vec::new()))
}

fn try_push_fresh(rt: AsyncRuntime) {
    if let Ok(mut guard) = pool().lock() {
        if guard.len() < js_flags::pool_size() {
            guard.push(rt);
        }
    }
}

/// Fill the pool with unused runtimes. Safe to call at process start.
pub fn prewarm() {
    if !js_flags::runtime_pool_enabled() {
        return;
    }
    let want = js_flags::pool_size();
    for _ in 0..want {
        let Ok(rt) = AsyncRuntime::new() else {
            break;
        };
        try_push_fresh(rt);
    }
}

pub async fn acquire_runtime() -> Result<AsyncRuntime, String> {
    let started = Instant::now();
    if js_flags::runtime_pool_enabled() {
        if let Ok(mut guard) = pool().lock() {
            if let Some(rt) = guard.pop() {
                js_timings::set_runtime_create(started.elapsed(), true);
                return Ok(rt);
            }
        }
    }
    let rt = AsyncRuntime::new().map_err(|e| e.to_string())?;
    js_timings::set_runtime_create(started.elapsed(), false);
    Ok(rt)
}

pub async fn release_runtime(rt: AsyncRuntime) {
    // Do not wait for user timers (e.g. setTimeout 60s) or pooling becomes a stall.
    let _ = tokio::time::timeout(std::time::Duration::from_millis(20), rt.idle()).await;
    rt.run_gc().await;
    drop(rt);
    if !js_flags::runtime_pool_enabled() {
        return;
    }
    // Recycle a *fresh* runtime, not the one that already ran user / LLRT attach.
    if let Ok(fresh) = AsyncRuntime::new() {
        try_push_fresh(fresh);
    }
}

pub fn pool_len() -> usize {
    pool().lock().map(|g| g.len()).unwrap_or(0)
}

pub fn drain_pool() {
    if let Ok(mut guard) = pool().lock() {
        guard.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::AsyncContext;

    fn set_env(key: &str, value: &str) {
        // SAFETY: test-only process env; these tests do not share the process with production.
        unsafe { std::env::set_var(key, value) }
    }

    fn unset_env(key: &str) {
        // SAFETY: test-only process env; these tests do not share the process with production.
        unsafe { std::env::remove_var(key) }
    }

    #[tokio::test]
    async fn new_context_does_not_leak_object_prototype() {
        set_env("BAAL_JS_RUNTIME_POOL", "1");
        drain_pool();
        let rt = acquire_runtime().await.expect("runtime");

        {
            let ctx = AsyncContext::full(&rt).await.expect("ctx a");
            rquickjs::async_with!(ctx => |ctx| {
                ctx.eval::<(), _>("Object.prototype.__baal_pwned = 'yes';")
                    .expect("pollute");
                Ok::<_, rquickjs::Error>(())
            })
            .await
            .expect("eval a");
            drop(ctx);
        }

        {
            let ctx = AsyncContext::full(&rt).await.expect("ctx b");
            let leaked: String = rquickjs::async_with!(ctx => |ctx| {
                ctx.eval::<String, _>("String(Object.prototype.__baal_pwned || 'clean')")
            })
            .await
            .expect("eval b");
            assert_eq!(
                leaked, "clean",
                "new context must not see prior prototype pollution"
            );
            drop(ctx);
        }

        release_runtime(rt).await;
        unset_env("BAAL_JS_RUNTIME_POOL");
        drain_pool();
    }

    #[tokio::test]
    async fn new_context_does_not_leak_global_this_or_timer() {
        set_env("BAAL_JS_RUNTIME_POOL", "1");
        drain_pool();
        let rt = acquire_runtime().await.expect("runtime");

        {
            let ctx = AsyncContext::full(&rt).await.expect("ctx a");
            rquickjs::async_with!(ctx => |ctx| {
                ctx.eval::<(), _>(
                    "globalThis.__baal_secret = 's3cret'; try { setTimeout(() => {}, 60000); } catch (e) {}",
                )
                .expect("store secret");
                Ok::<_, rquickjs::Error>(())
            })
            .await
            .expect("eval a");
            drop(ctx);
        }

        {
            let ctx = AsyncContext::full(&rt).await.expect("ctx b");
            let leaked: String = rquickjs::async_with!(ctx => |ctx| {
                ctx.eval::<String, _>("String(globalThis.__baal_secret || 'clean')")
            })
            .await
            .expect("eval b");
            assert_eq!(leaked, "clean", "new context must not see prior globalThis state");
            drop(ctx);
        }

        release_runtime(rt).await;
        unset_env("BAAL_JS_RUNTIME_POOL");
        drain_pool();
    }
}

//! Run QuickJS and other CPU-heavy unit work on Tokio's blocking pool so worker threads stay
//! available for Redis, Postgres, and NATS while API handlers and background consumers overlap.

use std::future::Future;

use crate::libs::unit_js::module_loader::get_tokio_handle;

/// Run `future` on a blocking thread (QuickJS / long sync SDK) so Tokio workers stay free for I/O.
pub async fn run_async_on_blocking_pool<F, R>(future: F) -> Result<R, String>
where
    F: Future<Output = Result<R, String>> + Send + 'static,
    R: Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let handle = get_tokio_handle()
            .ok_or_else(|| "run_async_on_blocking_pool: tokio runtime handle not available".to_string())?;
        handle.block_on(future)
    })
    .await
    .map_err(|_| "run_async_on_blocking_pool: task cancelled".to_string())?
}

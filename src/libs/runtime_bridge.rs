//! Run QuickJS and other CPU-heavy unit work on Tokio's blocking pool so worker threads stay
//! available for Redis, Postgres, and NATS while API handlers and background consumers overlap.

use std::future::Future;
use std::time::Duration;

use crate::libs::unit_js::module_loader::get_tokio_handle;

/// Logs every 30s while a long-running API unit handler is in `web::block` (TEST_MODE integration suites).
pub fn spawn_api_invoke_heartbeat(unit_path: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let start = std::time::Instant::now();
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            let metrics = tokio::runtime::Handle::current().metrics();
            tracing::info!(
                target: "runtime_trace",
                step = "api.invoke_unit.heartbeat",
                unit_path = %unit_path,
                elapsed_secs = start.elapsed().as_secs(),
                workers = metrics.num_workers(),
                alive_tasks = metrics.num_alive_tasks(),
                global_queue_depth = metrics.global_queue_depth(),
            );
        }
    })
}

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

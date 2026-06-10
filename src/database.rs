//! When running multiple replicas (e.g. 30 API + 30 workers), each process has its own pool.
//! Total PostgreSQL connections ≤ (API_replicas + worker_replicas) × max_size. Set max_size
//! so this stays under PostgreSQL `max_connections` (or put PgBouncer in front of Postgres).
//!
//! All DB access from async handlers must go through `block_on_db`; workers use
//! `block_on_db_tokio`. Never call `pool.get()` in handlers/async code — connections live
//! only inside the closure and must not be held across `.await`.

use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use std::time::Duration;

pub type DbPool = Pool<ConnectionManager<PgConnection>>;

/// Auto-reconnecting Redis handle (`redis` crate `ConnectionManager`).
pub type RedisConn = redis::aio::ConnectionManager;

pub type SharedRedisConn = Option<RedisConn>;

fn redis_connection_manager_config() -> redis::aio::ConnectionManagerConfig {
    let per_attempt = Duration::from_secs(2);
    redis::aio::ConnectionManagerConfig::new()
        .set_connection_timeout(Some(per_attempt))
        .set_response_timeout(Some(per_attempt))
        .set_min_delay(Duration::from_millis(100))
        .set_max_delay(Duration::from_secs(1))
        // Fail fast: ~4 connect attempts × 2s + backoffs ≈ 10s, then error to caller.
        .set_number_of_retries(3)
}

pub async fn connect_redis(url: &str) -> Result<RedisConn, String> {
    let client = redis::Client::open(url).map_err(|e| format!("redis client open: {e}"))?;
    redis::aio::ConnectionManager::new_with_config(client, redis_connection_manager_config())
        .await
        .map_err(|e| format!("redis connect ({url}): {e}"))
}

pub type PooledConn = diesel::r2d2::PooledConnection<ConnectionManager<PgConnection>>;

#[derive(Debug)]
pub enum BlockingDbError {
    Pool(r2d2::Error),
    Blocking,
    Query(diesel::result::Error),
}

impl std::fmt::Display for BlockingDbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlockingDbError::Pool(e) => write!(f, "pool: {}", e),
            BlockingDbError::Blocking => write!(f, "blocking task cancelled"),
            BlockingDbError::Query(e) => write!(f, "query: {}", e),
        }
    }
}

impl std::error::Error for BlockingDbError {}

impl From<r2d2::Error> for BlockingDbError {
    fn from(e: r2d2::Error) -> Self {
        BlockingDbError::Pool(e)
    }
}

impl From<diesel::result::Error> for BlockingDbError {
    fn from(e: diesel::result::Error) -> Self {
        BlockingDbError::Query(e)
    }
}

/// Runs blocking DB work on a dedicated thread so the async worker is not blocked.
/// Use this for all pool.get() + Diesel work in actix handlers, middlewares, and background consumers.
pub async fn block_on_db<F, R>(pool: &DbPool, f: F) -> Result<R, BlockingDbError>
where
    F: FnOnce(&mut PooledConn) -> Result<R, diesel::result::Error> + Send + 'static,
    R: Send + 'static,
{
    block_on_db_tokio(pool, f).await
}

/// Same as `block_on_db` but for tokio runtimes (e.g. the workflow_worker binary).
/// Use this in async code that runs on tokio so blocking r2d2/Diesel work doesn't block worker threads.
pub async fn block_on_db_tokio<F, R>(pool: &DbPool, f: F) -> Result<R, BlockingDbError>
where
    F: FnOnce(&mut PooledConn) -> Result<R, diesel::result::Error> + Send + 'static,
    R: Send + 'static,
{
    crate::rt_enter!("db.block_on_db_tokio");
    let pool = pool.clone();
    let out = match tokio::task::spawn_blocking(move || {
        crate::rt_step!("db.block_on_db_tokio.thread", action = "pool.get");
        let mut conn = pool.get().map_err(BlockingDbError::Pool)?;
        f(&mut conn).map_err(BlockingDbError::Query)
    })
    .await
    {
        Ok(r) => r,
        Err(_) => Err(BlockingDbError::Blocking),
    };
    match &out {
        Ok(_) => crate::rt_exit_ok!("db.block_on_db_tokio"),
        Err(e) => crate::rt_exit_err!("db.block_on_db_tokio", error = %e),
    }
    out
}

/// Shared metadata cache (`shared:units:*`, `shared:env:*`) on `REDIS_URL`.
/// When `redis_cache_enabled` is true, connection failure is fatal (no silent `None`).
pub async fn connect_shared_redis_cache(
    redis_cache_enabled: bool,
    redis_url: &str,
) -> Result<SharedRedisConn, String> {
    if !redis_cache_enabled {
        tracing::info!("[redis] cache disabled (REDIS_CACHE_ENABLED=false); skipping connection");
        return Ok(None);
    }
    let conn = connect_redis(redis_url).await?;
    tracing::info!(%redis_url, "[redis] shared metadata cache connected");
    Ok(Some(conn))
}

pub fn pg_pool_builder(
    max_size: u32,
    connection_timeout_secs: u64,
    idle_timeout_secs: u64,
) -> r2d2::Builder<ConnectionManager<PgConnection>> {
    let mut builder = Pool::builder()
        .max_size(max_size)
        .min_idle(Some(0))
        .connection_timeout(Duration::from_secs(connection_timeout_secs))
        .test_on_check_out(true);
    if idle_timeout_secs > 0 {
        builder = builder.idle_timeout(Some(Duration::from_secs(idle_timeout_secs)));
    }
    builder
}

pub fn establish_pool(
    database_url: String,
    max_size: u32,
    connection_timeout_secs: u64,
    idle_timeout_secs: u64,
) -> DbPool {
    let manager = ConnectionManager::<PgConnection>::new(&database_url);

    let pool = pg_pool_builder(max_size, connection_timeout_secs, idle_timeout_secs)
        .build(manager)
        .expect("Failed to create database pool");

    if let Err(e) = validate_pool_connection(&pool) {
        panic!(
            "Database connection failed at startup.\n\
             Check: DATABASE_URL is correct, PostgreSQL is running on the given host:port, and the user/password have access.\n\
             If running in Docker, use host.docker.internal or the service name instead of localhost.\n\
             Error: {:?}\nDisplay: {}",
            e, e
        );
    }

    tracing::info!("database pool connected successfully");
    pool
}

fn validate_pool_connection(pool: &DbPool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut conn = pool.get().map_err(|e| format!("pool get: {:?}", e))?;
    diesel::sql_query("SELECT 1")
        .execute(&mut conn)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
    Ok(())
}

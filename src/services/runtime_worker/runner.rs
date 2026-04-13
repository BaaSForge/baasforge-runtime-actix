use crate::configs::Settings;
use crate::database::establish_pool;
use crate::init_tracing;
use crate::models::projects::ProjectUnitType;
use crate::services::project_release::load_unit_for_path_production;
use crate::services::workflow_engine;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing();

    let settings = Settings::new()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;

    let redis_conn = if settings.redis_cache_enabled {
        let redis_client = redis::Client::open(settings.redis_url.as_str())?;
        let conn = redis_client.get_multiplexed_async_connection().await?;
        info!("Connected to Redis for cache");
        Some(Arc::new(Mutex::new(conn)))
    } else {
        info!("Redis skipped (REDIS_CACHE_ENABLED=false)");
        None
    };

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );

    let wf_redis: Option<Arc<Mutex<redis::aio::MultiplexedConnection>>> =
        if let Some(url) = &settings.wf_redis_url {
            match redis::Client::open(url.as_str()) {
                Ok(client) => match client.get_multiplexed_async_connection().await {
                    Ok(conn) => {
                        info!("[wf_redis] workflow Redis connected");
                        Some(Arc::new(Mutex::new(conn)))
                    }
                    Err(e) => {
                        warn!(error = %e, "[wf_redis] connection failed, workflow wake disabled");
                        None
                    }
                },
                Err(e) => {
                    warn!(error = %e, "[wf_redis] client open failed");
                    None
                }
            }
        } else {
            info!("[wf_redis] WF_REDIS_URL not set, workflow wake disabled");
            None
        };

    let nats_client: Option<async_nats::Client> = if let Some(url) = &settings.wf_nats_url {
        match async_nats::connect(url).await {
            Ok(client) => {
                info!("[nats_wf] connected for workflow wake consumer");
                Some(client)
            }
            Err(e) => {
                warn!(error = %e, "[nats_wf] connection failed, workflow wake disabled");
                None
            }
        }
    } else {
        info!("[nats_wf] NATS_WF_URL not set, workflow wake disabled");
        None
    };

    // If both wf_redis and nats are available, start the workflow wake consumer
    if let (Some(wf_redis), Some(nats)) = (&wf_redis, &nats_client) {
        let wf_redis = wf_redis.clone();
        let nats = nats.clone();
        let pool = pool.clone();
        let redis_conn_for_load = redis_conn.clone();

        info!("[workflow_wake] starting NATS consumer for wf.*.*.wake");

        tokio::spawn(async move {
            if let Err(e) = run_wake_consumer(wf_redis, nats, pool, redis_conn_for_load).await {
                error!(error = %e, "[workflow_wake] consumer exited with error");
            }
        });
    }

    // Keep the worker running
    info!("runtime_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("runtime_worker shutting down");

    Ok(())
}

async fn run_wake_consumer(
    wf_redis: Arc<Mutex<redis::aio::MultiplexedConnection>>,
    nats: async_nats::Client,
    pool: crate::database::DbPool,
    redis_conn: crate::database::SharedRedisConn,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use futures::StreamExt;

    let mut subscriber = nats.subscribe("wf.*.*.wake".to_string()).await?;
    info!("[workflow_wake] subscribed to wf.*.*.wake");

    while let Some(msg) = subscriber.next().await {
        let subject = msg.subject.to_string();

        // Parse subject: wf.{project_id}.{instance_id}.wake
        let parts: Vec<&str> = subject.split('.').collect();
        if parts.len() != 4 {
            warn!(subject = %subject, "[workflow_wake] unexpected subject format");
            continue;
        }
        let project_id = parts[1].to_string();
        let instance_id = parts[2].to_string();

        let wf_redis = wf_redis.clone();
        let nats_client = Some(nats.clone());
        let pool = pool.clone();
        let redis_conn = redis_conn.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_wake(
                &wf_redis,
                &nats_client,
                &pool,
                &redis_conn,
                &project_id,
                &instance_id,
            )
            .await
            {
                error!(
                    project_id = %project_id,
                    instance_id = %instance_id,
                    error = %e,
                    "[workflow_wake] resume failed"
                );
            }
        });
    }

    Ok(())
}

async fn handle_wake(
    wf_redis: &Arc<Mutex<redis::aio::MultiplexedConnection>>,
    nats_client: &Option<async_nats::Client>,
    pool: &crate::database::DbPool,
    redis_conn: &crate::database::SharedRedisConn,
    project_id: &str,
    instance_id: &str,
) -> Result<(), String> {
    // Load the workflow meta to get the unit path
    let meta_key = format!("wf:{project_id}:{instance_id}:meta");
    let meta_json: String = {
        let mut conn = wf_redis.lock().await;
        redis::cmd("GET")
            .arg(&meta_key)
            .query_async(&mut *conn)
            .await
            .map_err(|e| format!("redis GET meta: {e}"))?
    };

    let meta: workflow_engine::WorkflowMeta =
        serde_json::from_str(&meta_json).map_err(|e| format!("parse meta: {e}"))?;

    if meta.status == "completed" || meta.status == "failed" || meta.status == "cancelled" {
        return Ok(());
    }

    // Mark sleep as elapsed before resuming
    let suspended_key = format!("wf:{project_id}:{instance_id}:suspended");
    let suspended_json: Option<String> = {
        let mut conn = wf_redis.lock().await;
        redis::cmd("GET")
            .arg(&suspended_key)
            .query_async(&mut *conn)
            .await
            .map_err(|e| format!("redis GET suspended: {e}"))?
    };

    if let Some(raw) = &suspended_json
        && let Ok(val) = serde_json::from_str::<serde_json::Value>(raw)
        && val.get("type").and_then(|v| v.as_str()) == Some("sleep")
        && let Some(sleep_name) = val.get("name").and_then(|v| v.as_str())
    {
        let sleep_key = format!("wf:{project_id}:{instance_id}:sleep:{sleep_name}");
        let sleep_val = serde_json::json!({"elapsed": true}).to_string();
        let mut conn = wf_redis.lock().await;
        redis::cmd("SET")
            .arg(&sleep_key)
            .arg(&sleep_val)
            .query_async::<()>(&mut *conn)
            .await
            .map_err(|e| format!("redis SET sleep elapsed: {e}"))?;
    }

    // Parse unit path to load source code
    let unit_path = &meta.name;
    let parts: Vec<&str> = unit_path.split('.').collect();
    if parts.len() < 4 {
        return Err(format!("invalid unit path in meta: {unit_path}"));
    }

    let project_uuid = uuid::Uuid::parse_str(project_id)
        .map_err(|e| format!("invalid project_id: {e}"))?;

    let unit = load_unit_for_path_production(
        pool,
        redis_conn,
        project_uuid,
        ProjectUnitType::Workflow,
        unit_path,
    )
    .await
    .map_err(|e| format!("load unit: {e}"))?
    .ok_or_else(|| format!("workflow unit not found: {unit_path}"))?;

    let source = unit
        .compiled_code
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "workflow unit has no compiled code".to_string())?
        .to_string();

    workflow_engine::resume_workflow(wf_redis, nats_client, project_id, instance_id, &source)
        .await?;

    Ok(())
}

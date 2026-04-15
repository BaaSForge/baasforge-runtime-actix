use async_nats::jetstream;
use crate::configs::Settings;
use crate::database::establish_pool;
use crate::init_tracing;
use crate::models::projects::ProjectUnitType;
use crate::services::project_release::load_unit_for_path_production;
use crate::services::workflow_engine;
use futures::StreamExt;
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
        match crate::configs::connect_nats(url).await {
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
        info!("[nats_wf] WF_NATS_URL not set, workflow wake disabled");
        None
    };

    // If both wf_redis and nats are available, start the workflow wake consumer
    if let (Some(wf_redis), Some(nats)) = (&wf_redis, &nats_client) {
        let wf_redis = wf_redis.clone();
        let nats = nats.clone();
        let pool = pool.clone();
        let redis_conn_for_load = redis_conn.clone();
        let stream_name = settings
            .wf_nats_jetstream_stream
            .as_deref()
            .unwrap_or("WF_WAKE")
            .to_string();
        let consumer_name = settings
            .wf_nats_jetstream_consumer
            .as_deref()
            .unwrap_or("wf_wake_consumer")
            .to_string();

        info!("[workflow_wake] starting JetStream pull consumer for wf.*.*.wake");

        tokio::spawn(async move {
            if let Err(e) =
                run_wake_consumer(wf_redis, nats, pool, redis_conn_for_load, &stream_name, &consumer_name).await
            {
                error!(error = %e, "[workflow_wake] consumer exited with error");
            }
        });
    }

    // Keep the worker running
    info!("workflow_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("workflow_worker shutting down");

    Ok(())
}

pub async fn run_wake_consumer(
    wf_redis: Arc<Mutex<redis::aio::MultiplexedConnection>>,
    nats: async_nats::Client,
    pool: crate::database::DbPool,
    redis_conn: crate::database::SharedRedisConn,
    stream_name: &str,
    consumer_name: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let js = jetstream::new(nats.clone());

    let stream = js
        .get_or_create_stream(async_nats::jetstream::stream::Config {
            name: stream_name.to_string(),
            subjects: vec!["wf.*.*.wake".to_string()],
            ..Default::default()
        })
        .await?;

    let consumer = stream
        .get_or_create_consumer(
            consumer_name,
            async_nats::jetstream::consumer::pull::Config {
                durable_name: Some(consumer_name.to_string()),
                filter_subject: "wf.*.*.wake".to_string(),
                ack_wait: std::time::Duration::from_secs(30),
                ..Default::default()
            },
        )
        .await?;

    info!(
        stream = %stream_name,
        consumer = %consumer_name,
        "[workflow_wake] JetStream pull consumer ready"
    );

    let mut messages = consumer.messages().await?;

    while let Some(result) = messages.next().await {
        match result {
            Ok(msg) => {
                let subject = msg.subject.to_string();

                // Parse subject: wf.{project_id}.{instance_id}.wake
                let parts: Vec<&str> = subject.split('.').collect();
                if parts.len() != 4 {
                    warn!(subject = %subject, "[workflow_wake] unexpected subject format");
                    let _ = msg.ack().await;
                    continue;
                }
                let project_id = parts[1].to_string();
                let instance_id = parts[2].to_string();

                let payload: Option<serde_json::Value> =
                    serde_json::from_slice(&msg.payload).ok();

                // Check fire_at: if the message isn't due yet, NAK with remaining delay
                // so the server redelivers it when the timer expires.
                let fire_at = payload
                    .as_ref()
                    .and_then(|p| p.get("fire_at"))
                    .and_then(|v| v.as_i64());

                if let Some(fire_at_ms) = fire_at {
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    let remaining = fire_at_ms - now_ms;
                    if remaining > 0 {
                        let delay = std::time::Duration::from_millis(remaining as u64);
                        if let Err(e) = msg
                            .ack_with(async_nats::jetstream::AckKind::Nak(Some(delay)))
                            .await
                        {
                            error!(error = %e, "[workflow_wake] nak_with_delay failed");
                        }
                        continue;
                    }
                }

                let wf_redis = wf_redis.clone();
                let nats_client = Some(nats.clone());
                let pool = pool.clone();
                let redis_conn = redis_conn.clone();

                if let Err(e) = handle_wake(
                    &wf_redis,
                    &nats_client,
                    &pool,
                    &redis_conn,
                    &project_id,
                    &instance_id,
                    payload.as_ref(),
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

                if let Err(e) = msg.ack().await {
                    error!(error = %e, "[workflow_wake] ack failed");
                }
            }
            Err(e) => {
                error!(error = %e, "[workflow_wake] consumer stream error");
            }
        }
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
    payload: Option<&serde_json::Value>,
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

    // Mark promise as timed_out before resuming
    let reason = payload
        .and_then(|p| p.get("reason"))
        .and_then(|v| v.as_str());
    if reason == Some("promise_timed_out") {
        if let Some(promise_name) = payload
            .and_then(|p| p.get("promise"))
            .and_then(|v| v.as_str())
        {
            let promise_key = format!("wf:{project_id}:{instance_id}:promise:{promise_name}");
            let timed_out_val = serde_json::json!({"status": "timed_out"}).to_string();
            let mut conn = wf_redis.lock().await;
            redis::cmd("SET")
                .arg(&promise_key)
                .arg(&timed_out_val)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(|e| format!("redis SET promise timed_out: {e}"))?;
        }
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

    let js = nats_client
        .as_ref()
        .map(|c| async_nats::jetstream::new(c.clone()));
    workflow_engine::resume_workflow(wf_redis, nats_client, &js, project_id, instance_id, &source)
        .await?;

    Ok(())
}

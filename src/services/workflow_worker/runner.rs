use async_nats::jetstream;
use crate::configs::Settings;
use crate::services::usage_meter::UsageMeterMemory;
use crate::database::establish_pool;
use crate::{init_tracing, shutdown_telemetry};
use crate::libs::unit_js::modules::sdk::{SdkActorLocks, SdkCommCtx, SharedRedis};
use crate::services::actor_engine::ActorRedis;
use crate::models::actor_store::{build_actor_pg_pool, ActorPgPool};
use crate::models::projects::ProjectUnitType;
use crate::services::project_release::{
    live_release_and_runtime_ids_for_scope, load_unit_for_path_scoped,
};
use crate::services::storage_meter::{
    meter_nats_decr, meter_redis_del, meter_redis_set, meter_wf_redis_set_with_old,
    redis_key_usage_bytes, STORE_NATS_WF, STORE_WF_REDIS, TIER_ACTIVE,
};
use crate::services::workflow_engine;
use futures::StreamExt;
use opentelemetry::trace::FutureExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakeProcessOutcome {
    Processed,
    ExecLockHeld,
}

const WAKE_CONSUMER_MAX_ACK_PENDING: i64 = 1024;
const EXEC_LOCK_BUSY_NAK: std::time::Duration = std::time::Duration::from_millis(200);

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    init_tracing("workflow_worker");

    let settings = Settings::new()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;

    crate::configs::start_usage_publisher_if_enabled(&settings);

    let redis_conn = crate::database::connect_shared_redis_cache(
        settings.redis_cache_enabled,
        &settings.redis_url,
    )
    .await
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
        settings.database_pool_idle_timeout_secs,
    );

    let wf_redis = crate::database::connect_redis(&settings.wf_redis_url).await?;
    info!("[wf_redis] workflow Redis connected");

    let nats_client: Option<async_nats::Client> = if let Some(url) = &settings.wf_nats_url {
        let client = crate::configs::connect_nats(url).await?;
        info!("[nats_wf] NATS client ready for workflow wake consumer");
        Some(client)
    } else {
        info!("[nats_wf] WF_NATS_URL not set, workflow wake disabled");
        None
    };

    let actor_locks: SdkActorLocks = Arc::new(Mutex::new(HashMap::new()));

    let actor_redis = crate::database::connect_redis(&settings.actor_redis_url).await?;
    info!("[actor_redis] actor Redis connected");

    let actor_nats: Option<async_nats::Client> = if let Some(url) = settings.actor_nats_url.as_deref() {
        match crate::configs::connect_nats(url).await {
            Ok(nc) => {
                info!("[nats_actor] connected for workflow wake (sdk.callActor*)");
                Some(nc)
            }
            Err(e) => {
                warn!(error = %e, "[nats_actor] connect failed");
                None
            }
        }
    } else {
        info!("[nats_actor] ACTOR_NATS_URL unset; sdk.callActor* disabled in workflow wake");
        None
    };

    let actor_js = actor_nats
        .as_ref()
        .map(|nc| jetstream::new(nc.clone()));

    let actor_pg: Option<ActorPgPool> = settings.actor_database_url.as_ref().map(|url| {
        build_actor_pg_pool(
            url,
            settings.actor_database_pool_size.max(1),
            settings.actor_database_connection_timeout_secs.max(1),
            settings.actor_database_pool_idle_timeout_secs,
        )
    });

    let wq_redis = crate::database::connect_redis(&settings.wq_redis_url).await?;
    info!("[wq_redis] queue worker Redis connected");

    let wq_nats: Option<async_nats::Client> = if let Some(url) = settings.wq_nats_url.as_deref() {
        match crate::configs::connect_nats(url).await {
            Ok(nc) => {
                info!("[nats_wq] connected for workflow wake (sdk.enqueueWorker*)");
                Some(nc)
            }
            Err(e) => {
                warn!(error = %e, "[nats_wq] connect failed");
                None
            }
        }
    } else {
        info!("[nats_wq] WQ_NATS_URL unset; sdk.enqueueWorker* may be limited in workflow wake");
        None
    };

    let wq_js = wq_nats
        .as_ref()
        .map(|nc| jetstream::new(nc.clone()));

    if let Some(nats) = &nats_client {
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
        let actor_redis = actor_redis.clone();
        let actor_nats = actor_nats.clone();
        let actor_js = actor_js.clone();
        let actor_pg = actor_pg.clone();
        let actor_locks = actor_locks.clone();
        let wq_redis = wq_redis.clone();
        let wq_nats = wq_nats.clone();
        let wq_js = wq_js.clone();
        let usage_meter = settings.usage_meter;

        info!("[workflow_wake] starting JetStream pull consumer for wf.*.*.wake");

        tokio::spawn(async move {
            if let Err(e) = run_wake_consumer(
                wf_redis,
                nats,
                pool,
                redis_conn_for_load,
                &stream_name,
                &consumer_name,
                actor_redis,
                actor_nats,
                actor_js,
                actor_pg,
                actor_locks,
                wq_redis,
                wq_nats,
                wq_js,
                usage_meter,
            )
            .await
            {
                error!(error = %e, "[workflow_wake] consumer exited with error");
            }
        });
    }

    // Keep the worker running
    info!("workflow_worker running, press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    info!("workflow_worker shutting down");
    shutdown_telemetry();

    Ok(())
}

pub async fn run_wake_consumer(
    wf_redis: SharedRedis,
    nats: async_nats::Client,
    pool: crate::database::DbPool,
    redis_conn: crate::database::SharedRedisConn,
    stream_name: &str,
    consumer_name: &str,
    actor_redis: ActorRedis,
    actor_nats: Option<async_nats::Client>,
    actor_js: Option<jetstream::Context>,
    actor_pg: Option<ActorPgPool>,
    actor_locks: SdkActorLocks,
    wq_redis: SharedRedis,
    wq_nats: Option<async_nats::Client>,
    wq_js: Option<jetstream::Context>,
    usage_meter: UsageMeterMemory,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let js = jetstream::new(nats.clone());
    let wake_subjects = vec!["wf.*.*.wake".to_string(), "wf.*.*.start".to_string()];
    let mut backoff_attempt = 0usize;

    loop {
        if let Err(e) = js
            .create_or_update_stream(async_nats::jetstream::stream::Config {
                name: stream_name.to_string(),
                subjects: wake_subjects.clone(),
                ..Default::default()
            })
            .await
        {
            error!(error = %e, "[workflow_wake] stream setup failed; retrying");
            crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
            continue;
        }

        let stream = match js.get_stream(stream_name).await {
            Ok(s) => s,
            Err(e) => {
                error!(error = %e, "[workflow_wake] get_stream failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        let consumer: async_nats::jetstream::consumer::Consumer<
            async_nats::jetstream::consumer::pull::Config,
        > = match stream
            .create_consumer(async_nats::jetstream::consumer::pull::Config {
                durable_name: Some(consumer_name.to_string()),
                filter_subjects: wake_subjects.clone(),
                ack_wait: std::time::Duration::from_secs(300),
                max_ack_pending: WAKE_CONSUMER_MAX_ACK_PENDING,
                ..Default::default()
            })
            .await
        {
            Ok(c) => c,
            Err(e) => {
                error!(error = %e, "[workflow_wake] create_consumer failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        info!(
            stream = %stream_name,
            consumer = %consumer_name,
            "[workflow_wake] JetStream pull consumer reconnecting (wake + start)"
        );

        let mut messages = match consumer.messages().await {
            Ok(m) => {
                backoff_attempt = 0;
                m
            }
            Err(e) => {
                error!(error = %e, "[workflow_wake] messages stream failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        while let Some(result) = messages.next().await {
            match result {
            Ok(msg) => {
                let subject = msg.subject.to_string();

                let parts: Vec<&str> = subject.split('.').collect();
                if parts.len() != 4 {
                    warn!(subject = %subject, "[workflow_wake] unexpected subject format");
                    if let Some(project_id) = parts.get(1) {
                        meter_nats_decr(project_id, STORE_NATS_WF, &subject, msg.payload.as_ref());
                    }
                    let _ = msg.ack().await;
                    continue;
                }
                let project_id = parts[1].to_string();
                let instance_id = parts[2].to_string();
                let msg_type = parts[3].to_string();

                let payload: Option<serde_json::Value> =
                    serde_json::from_slice(&msg.payload).ok();

                if msg_type == "wake" {
                    if let Some(fire_at_ms) = payload
                        .as_ref()
                        .and_then(|p| p.get("fire_at"))
                        .and_then(|v| v.as_i64())
                    {
                        let remaining = fire_at_ms - chrono::Utc::now().timestamp_millis();
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
                }

                let wf_redis = wf_redis.clone();
                let nats_client = Some(nats.clone());
                let pool = pool.clone();
                let redis_conn = redis_conn.clone();
                let actor_redis = actor_redis.clone();
                let actor_nats = actor_nats.clone();
                let actor_js = actor_js.clone();
                let actor_pg = actor_pg.clone();
                let actor_locks = actor_locks.clone();
                let wq_redis = wq_redis.clone();
                let wq_nats = wq_nats.clone();
                let wq_js = wq_js.clone();
                let usage_meter = usage_meter;

                tokio::spawn(async move {
                    let heartbeat_msg = msg.clone();
                    let heartbeat = tokio::spawn(async move {
                        let mut interval =
                            tokio::time::interval(std::time::Duration::from_secs(15));
                        interval.tick().await;
                        loop {
                            interval.tick().await;
                            if heartbeat_msg
                                .ack_with(async_nats::jetstream::AckKind::Progress)
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    });

                    let outcome = if msg_type == "start" {
                        handle_start(
                            &wf_redis,
                            &nats_client,
                            &pool,
                            &redis_conn,
                            &project_id,
                            &instance_id,
                            payload.as_ref(),
                            actor_redis,
                            actor_nats,
                            actor_js,
                            actor_pg,
                            actor_locks,
                            wq_redis,
                            wq_nats,
                            wq_js,
                            usage_meter,
                        )
                        .await
                        .map_err(|e| {
                            error!(
                                project_id = %project_id,
                                instance_id = %instance_id,
                                error = %e,
                                "[workflow_wake] callee start failed"
                            );
                            e
                        })
                    } else {
                        handle_wake(
                            &wf_redis,
                            &nats_client,
                            &pool,
                            &redis_conn,
                            &project_id,
                            &instance_id,
                            payload.as_ref(),
                            actor_redis,
                            actor_nats,
                            actor_js,
                            actor_pg,
                            actor_locks,
                            wq_redis,
                            wq_nats,
                            wq_js,
                            usage_meter,
                        )
                        .await
                        .map_err(|e| {
                            error!(
                                project_id = %project_id,
                                instance_id = %instance_id,
                                error = %e,
                                "[workflow_wake] resume failed"
                            );
                            e
                        })
                    };

                    finalize_wake_message(msg, heartbeat, outcome).await;
                });
            }
            Err(e) => {
                error!(error = %e, "[workflow_wake] consumer stream error; reconnecting");
                break;
            }
            }
        }

        warn!("[workflow_wake] pull stream ended; reconnecting");
        crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
    }
}

async fn finalize_wake_message(
    msg: async_nats::jetstream::Message,
    heartbeat: tokio::task::JoinHandle<()>,
    outcome: Result<WakeProcessOutcome, String>,
) {
    heartbeat.abort();
    match outcome {
        Ok(WakeProcessOutcome::ExecLockHeld) => {
            if let Err(e) = msg
                .ack_with(async_nats::jetstream::AckKind::Nak(Some(EXEC_LOCK_BUSY_NAK)))
                .await
            {
                error!(error = %e, "[workflow_wake] nak exec_lock busy failed");
            }
        }
        Ok(WakeProcessOutcome::Processed) | Err(_) => {
            let subject = msg.subject.to_string();
            if let Some(project_id) = subject.split('.').nth(1) {
                meter_nats_decr(project_id, STORE_NATS_WF, &subject, msg.payload.as_ref());
            }
            if let Err(e) = msg.ack().await {
                error!(error = %e, "[workflow_wake] ack failed");
            }
        }
    }
}

async fn handle_start(
    wf_redis: &SharedRedis,
    nats_client: &Option<async_nats::Client>,
    pool: &crate::database::DbPool,
    redis_conn: &crate::database::SharedRedisConn,
    project_id: &str,
    instance_id: &str,
    _payload: Option<&serde_json::Value>,
    actor_redis: ActorRedis,
    actor_nats: Option<async_nats::Client>,
    actor_js: Option<jetstream::Context>,
    actor_pg: Option<ActorPgPool>,
    actor_locks: SdkActorLocks,
    wq_redis: SharedRedis,
    wq_nats: Option<async_nats::Client>,
    wq_js: Option<jetstream::Context>,
    usage_meter: UsageMeterMemory,
) -> Result<WakeProcessOutcome, String> {
    let trace_payload = _payload.cloned();

    let wf_redis = wf_redis.clone();
    let nats_client = nats_client.clone();
    let pool = pool.clone();
    let redis_conn = redis_conn.clone();
    let project_id = project_id.to_string();
    let instance_id = instance_id.to_string();
    let actor_redis = actor_redis.clone();
    let actor_nats = actor_nats.clone();
    let actor_js = actor_js.clone();
    let actor_pg = actor_pg.clone();
    let actor_locks = actor_locks.clone();
    let wq_redis = wq_redis.clone();
    let wq_nats = wq_nats.clone();
    let wq_js = wq_js.clone();
    let usage_meter = usage_meter;

    (async move {
    let meta_key = format!("wf:{project_id}:{instance_id}:meta");
    let meta_json: String = {
        let mut conn = wf_redis.clone();
        let raw: Option<String> = redis::cmd("GET")
            .arg(&meta_key)
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("handle_start: redis GET meta: {e}"))?;
        raw.ok_or_else(|| "handle_start: meta not found".to_string())?
    };
    let wf_meta: workflow_engine::WorkflowMeta =
        serde_json::from_str(&meta_json).map_err(|e| format!("handle_start: parse meta: {e}"))?;
    let unit_path = wf_meta.name.clone();
    let input_json = wf_meta.input.clone();
    let stage_runtime_id = wf_meta.stage_runtime_id;
    let rid_owned = stage_runtime_id.map(|u| u.to_string());
    let inner_rt = if stage_runtime_id.is_some() {
        "stage"
    } else {
        "production"
    };
    let project_uuid = uuid::Uuid::parse_str(project_id.as_str())
        .map_err(|e| format!("handle_start: invalid project_id: {e}"))?;
    let (release_id_owned, resolved_runtime_id) = {
        let (release_id, runtime_id) =
            live_release_and_runtime_ids_for_scope(&pool, &redis_conn, project_uuid, stage_runtime_id)
                .await;
        (release_id.map(|u| u.to_string()), runtime_id)
    };
    let corr = crate::telemetry::trigger_correlation_from_payload(
        trace_payload.as_ref().unwrap_or(&serde_json::Value::Null),
    );
    let messaging_dest = format!("wf.{project_id}.{instance_id}.start");
    let extras = crate::telemetry::AsyncConsumerSpanExtras {
        messaging_destination: Some(messaging_dest.as_str()),
        baal_unit_path: Some(unit_path.as_str()),
        baal_workflow_instance_id: Some(instance_id.as_str()),
        baal_release_id: release_id_owned.as_deref(),
        ..Default::default()
    };
    let consumer_cx = crate::telemetry::async_consumer_context(
        &corr,
        "baal.consumer.workflow.start",
        "workflow_start",
        Some(project_id.as_str()),
        Some(inner_rt),
        rid_owned.as_deref(),
        Some(&extras),
    );
    (async move {
    let unit = load_unit_for_path_scoped(
        &pool,
        &redis_conn,
        project_uuid,
        stage_runtime_id,
        ProjectUnitType::Workflow,
        &unit_path,
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

    let source = crate::libs::unit_js::prepare_source_scoped(
        &source,
        &pool,
        &redis_conn,
        project_uuid,
        stage_runtime_id,
    )
    .await
    .map_err(|e| match e {
        crate::libs::unit_js::PrepareError::WrongImport
        | crate::libs::unit_js::PrepareError::UnnamedImport => {
            crate::libs::unit_js::WRONG_IMPORT_MSG.to_string()
        }
        crate::libs::unit_js::PrepareError::Load(msg) => msg,
    })?;

    let js = nats_client
        .as_ref()
        .map(|c| async_nats::jetstream::new(c.clone()));

    let lock_key = format!("wf:{project_id}:{instance_id}:exec_lock");
    let acquired: bool = {
        let mut conn = wf_redis.clone();
        let old_lock_bytes = redis_key_usage_bytes(&mut conn, &lock_key).await;
        let acquired: bool = redis::cmd("SET")
            .arg(&lock_key)
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(300u64)
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("exec_lock acquire: {e}"))?;
        if acquired {
            meter_wf_redis_set_with_old(&mut conn, &project_id, &lock_key, old_lock_bytes, "1").await;
        }
        acquired
    };
    if !acquired {
        return Ok(WakeProcessOutcome::ExecLockHeld);
    }

    let comm = Arc::new(SdkCommCtx {
        pool: pool.clone(),
        redis_conn: redis_conn.clone(),
        wf_redis: wf_redis.clone(),
        wf_nats: nats_client.clone(),
        wf_js: js.clone(),
        wq_redis,
        wq_nats,
        wq_js,
        actor_redis,
        actor_nats,
        actor_js,
        actor_pg,
        actor_locks,
        project_id: project_id.clone(),
        source_unit_path: unit_path.clone(),
        source_instance_id: Some(instance_id.clone()),
        stage_runtime_id,
        resolved_runtime_id,
        sdk_public_host: "localhost".to_string(),
        sdk_trigger_base_path: String::new(),
        usage_meter,
    });

    let result = workflow_engine::launch_callee_workflow(
        &wf_redis,
        &nats_client,
        &js,
        project_id.as_str(),
        instance_id.as_str(),
        &input_json,
        &source,
        &unit_path,
        comm,
    )
    .await;

    {
        let mut conn = wf_redis.clone();
        meter_redis_del(&mut conn, &project_id, STORE_WF_REDIS, TIER_ACTIVE, &lock_key).await;
        let _: () = redis::cmd("DEL")
            .arg(&lock_key)
            .query_async(&mut conn)
            .await
            .unwrap_or(());
    }

    result.map(|_| WakeProcessOutcome::Processed)
    })
    .with_context(consumer_cx)
    .await
    })
    .await
}

async fn handle_wake(
    wf_redis: &SharedRedis,
    nats_client: &Option<async_nats::Client>,
    pool: &crate::database::DbPool,
    redis_conn: &crate::database::SharedRedisConn,
    project_id: &str,
    instance_id: &str,
    payload: Option<&serde_json::Value>,
    actor_redis: ActorRedis,
    actor_nats: Option<async_nats::Client>,
    actor_js: Option<jetstream::Context>,
    actor_pg: Option<ActorPgPool>,
    actor_locks: SdkActorLocks,
    wq_redis: SharedRedis,
    wq_nats: Option<async_nats::Client>,
    wq_js: Option<jetstream::Context>,
    usage_meter: UsageMeterMemory,
) -> Result<WakeProcessOutcome, String> {
    let wake_payload = payload.cloned();

    let wf_redis = wf_redis.clone();
    let nats_client = nats_client.clone();
    let pool = pool.clone();
    let redis_conn = redis_conn.clone();
    let project_id = project_id.to_string();
    let instance_id = instance_id.to_string();
    let actor_redis = actor_redis.clone();
    let actor_nats = actor_nats.clone();
    let actor_js = actor_js.clone();
    let actor_pg = actor_pg.clone();
    let actor_locks = actor_locks.clone();
    let wq_redis = wq_redis.clone();
    let wq_nats = wq_nats.clone();
    let wq_js = wq_js.clone();
    let usage_meter = usage_meter;

    (async move {
    crate::rt_enter!("wf.consumer.handle_wake", project_id = %project_id, instance_id = %instance_id);
    let payload = wake_payload.as_ref();

    // Load the workflow meta to get the unit path
    let meta_key = format!("wf:{project_id}:{instance_id}:meta");
    let meta_json: String = {
        let mut conn = wf_redis.clone();
        redis::cmd("GET")
            .arg(&meta_key)
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("redis GET meta: {e}"))?
    };

    let meta: workflow_engine::WorkflowMeta =
        serde_json::from_str(&meta_json).map_err(|e| format!("parse meta: {e}"))?;
    let stage_runtime_id = meta.stage_runtime_id;
    let rid_owned = stage_runtime_id.map(|u| u.to_string());
    let inner_rt = if stage_runtime_id.is_some() {
        "stage"
    } else {
        "production"
    };
    let project_uuid = uuid::Uuid::parse_str(project_id.as_str())
        .map_err(|e| format!("handle_wake: invalid project_id: {e}"))?;
    let (release_id_owned, resolved_runtime_id) = {
        let (release_id, runtime_id) =
            live_release_and_runtime_ids_for_scope(&pool, &redis_conn, project_uuid, stage_runtime_id)
                .await;
        (release_id.map(|u| u.to_string()), runtime_id)
    };
    let corr = crate::telemetry::trigger_correlation_from_payload(
        wake_payload
            .as_ref()
            .unwrap_or(&serde_json::Value::Null),
    );
    let wake_reason = wake_payload
        .as_ref()
        .and_then(|p| p.get("reason"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let messaging_dest = format!("wf.{project_id}.{instance_id}.wake");
    let extras = crate::telemetry::AsyncConsumerSpanExtras {
        messaging_destination: Some(messaging_dest.as_str()),
        baal_unit_path: Some(meta.name.as_str()),
        baal_workflow_instance_id: Some(instance_id.as_str()),
        baal_wake_reason: wake_reason.as_deref(),
        baal_release_id: release_id_owned.as_deref(),
        ..Default::default()
    };
    let consumer_cx = crate::telemetry::async_consumer_context(
        &corr,
        "baal.consumer.workflow.wake",
        "workflow_wake",
        Some(project_id.as_str()),
        Some(inner_rt),
        rid_owned.as_deref(),
        Some(&extras),
    );
    (async move {
    if meta.status == "completed" || meta.status == "failed" || meta.status == "cancelled" {
        return Ok(WakeProcessOutcome::Processed);
    }

    // Mark sleep as elapsed before resuming
    let suspended_key = format!("wf:{project_id}:{instance_id}:suspended");
    let suspended_json: Option<String> = {
        let mut conn = wf_redis.clone();
        redis::cmd("GET")
            .arg(&suspended_key)
            .query_async(&mut conn)
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
        let mut conn = wf_redis.clone();
        meter_redis_set(&mut conn, &project_id, STORE_WF_REDIS, TIER_ACTIVE, &sleep_key, &sleep_val).await;
        redis::cmd("SET")
            .arg(&sleep_key)
            .arg(&sleep_val)
            .query_async::<()>(&mut conn)
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
            let mut conn = wf_redis.clone();
            meter_redis_set(
                &mut conn,
                &project_id,
                STORE_WF_REDIS,
                TIER_ACTIVE,
                &promise_key,
                &timed_out_val,
            )
            .await;
            redis::cmd("SET")
                .arg(&promise_key)
                .arg(&timed_out_val)
                .query_async::<()>(&mut conn)
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

    let unit = load_unit_for_path_scoped(
        &pool,
        &redis_conn,
        project_uuid,
        stage_runtime_id,
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

    let source = crate::libs::unit_js::prepare_source_scoped(
        &source,
        &pool,
        &redis_conn,
        project_uuid,
        stage_runtime_id,
    )
    .await
    .map_err(|e| match e {
        crate::libs::unit_js::PrepareError::WrongImport
        | crate::libs::unit_js::PrepareError::UnnamedImport => {
            crate::libs::unit_js::WRONG_IMPORT_MSG.to_string()
        }
        crate::libs::unit_js::PrepareError::Load(msg) => msg,
    })?;

    let js = nats_client
        .as_ref()
        .map(|c| async_nats::jetstream::new(c.clone()));

    let lock_key = format!("wf:{project_id}:{instance_id}:exec_lock");
    let acquired: bool = {
        let mut conn = wf_redis.clone();
        let old_lock_bytes = redis_key_usage_bytes(&mut conn, &lock_key).await;
        let acquired: bool = redis::cmd("SET")
            .arg(&lock_key)
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(300u64)
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("exec_lock acquire: {e}"))?;
        if acquired {
            meter_wf_redis_set_with_old(&mut conn, &project_id, &lock_key, old_lock_bytes, "1").await;
        }
        acquired
    };
    if !acquired {
        return Ok(WakeProcessOutcome::ExecLockHeld);
    }

    let comm = Arc::new(SdkCommCtx {
        pool: pool.clone(),
        redis_conn: redis_conn.clone(),
        wf_redis: wf_redis.clone(),
        wf_nats: nats_client.clone(),
        wf_js: js.clone(),
        wq_redis,
        wq_nats,
        wq_js,
        actor_redis,
        actor_nats,
        actor_js,
        actor_pg,
        actor_locks,
        project_id: project_id.clone(),
        source_unit_path: unit_path.to_string(),
        source_instance_id: Some(instance_id.clone()),
        stage_runtime_id,
        resolved_runtime_id,
        sdk_public_host: "localhost".to_string(),
        sdk_trigger_base_path: String::new(),
        usage_meter,
    });

    let result = workflow_engine::resume_workflow(
        &wf_redis,
        &nats_client,
        &js,
        project_id.as_str(),
        instance_id.as_str(),
        &source,
        comm,
    )
    .await;

    {
        let mut conn = wf_redis.clone();
        meter_redis_del(&mut conn, &project_id, STORE_WF_REDIS, TIER_ACTIVE, &lock_key).await;
        let _: () = redis::cmd("DEL")
            .arg(&lock_key)
            .query_async(&mut conn)
            .await
            .unwrap_or(());
    }

    result.map(|_| WakeProcessOutcome::Processed)
    })
    .with_context(consumer_cx)
    .await
    })
    .await
}

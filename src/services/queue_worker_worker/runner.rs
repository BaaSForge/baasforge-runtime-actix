use async_nats::jetstream;
use futures::StreamExt;
use redis::AsyncCommands;
use tracing::{error, info, warn};

use crate::database::DbPool;
use crate::libs::unit_js::queue_worker_runner::{
    BatchConfig, QueueWorkerRunContext, QueueWorkerRunOutcome,
    extract_worker_metadata, queue_worker_backoff_delay, run_worker_handler,
};
use crate::models::projects::ProjectUnitType;
use crate::services::project_release::load_unit_for_path_production;
use crate::services::queue_worker_engine::{
    QueueWorkerRunMeta, QueueWorkerRedis, WQ_NATS_WORK_SUBJECT_PER_PROJECT,
    WQ_NATS_WORK_STREAM_SUBJECTS, publish_qw_event,
};

pub async fn run_work_consumer(
    wq_redis: QueueWorkerRedis,
    nats: async_nats::Client,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    stream_name: &str,
    consumer_name: &str,
    base_url: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let js = jetstream::new(nats.clone());

    let subjects: Vec<String> = WQ_NATS_WORK_STREAM_SUBJECTS
        .iter()
        .map(|s| s.to_string())
        .collect();

    js.create_or_update_stream(async_nats::jetstream::stream::Config {
        name: stream_name.to_string(),
        subjects,
        ..Default::default()
    })
    .await?;

    let stream = js.get_stream(stream_name).await?;

    let filter_subject = format!("wq.*.{WQ_NATS_WORK_SUBJECT_PER_PROJECT}.work");
    let consumer: async_nats::jetstream::consumer::Consumer<
        async_nats::jetstream::consumer::pull::Config,
    > = stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            durable_name: Some(consumer_name.to_string()),
            filter_subjects: vec![filter_subject],
            ack_wait: std::time::Duration::from_secs(300),
            ..Default::default()
        })
        .await?;

    info!(
        stream = %stream_name,
        consumer = %consumer_name,
        "[queue_worker_consumer] JetStream pull consumer ready"
    );

    let mut messages = consumer.messages().await?;

    while let Some(result) = messages.next().await {
        match result {
            Ok(msg) => {
                let wq_redis = wq_redis.clone();
                let nats = nats.clone();
                let pool = pool.clone();
                let redis_conn = redis_conn.clone();
                let base_url = base_url.to_string();

                tokio::spawn(async move {
                    handle_work_message(msg, wq_redis, nats, pool, redis_conn, base_url).await;
                });
            }
            Err(e) => {
                error!(error = %e, "[queue_worker_consumer] consumer stream error");
            }
        }
    }

    Ok(())
}

async fn handle_work_message(
    msg: async_nats::jetstream::Message,
    wq_redis: QueueWorkerRedis,
    nats: async_nats::Client,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    base_url: String,
) {
    let subject = msg.subject.to_string();
    let parts: Vec<&str> = subject.split('.').collect();
    if parts.len() != 4 {
        warn!(subject = %subject, "[queue_worker_consumer] unexpected subject format");
        let _ = msg.ack().await;
        return;
    }
    let project_id = parts[1].to_string();

    let payload: Option<serde_json::Value> = serde_json::from_slice(&msg.payload).ok();

    let run_id = payload
        .as_ref()
        .and_then(|p| p.get("runId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let data_json = payload
        .as_ref()
        .and_then(|p| p.get("data"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let unit_path = payload
        .as_ref()
        .and_then(|p| p.get("unitPath"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let (Some(run_id), Some(unit_path)) = (run_id, unit_path) else {
        warn!("[queue_worker_consumer] missing runId or unitPath in payload");
        let _ = msg.ack().await;
        return;
    };

    let meta_key = format!("wq:{project_id}:{run_id}:meta");

    let meta_raw: Option<String> = {
        let mut conn = wq_redis.lock().await;
        conn.get(&meta_key).await.unwrap_or(None)
    };
    let Some(raw) = meta_raw else {
        warn!(run_id = %run_id, "[queue_worker_consumer] run meta not found, acking");
        let _ = msg.ack().await;
        return;
    };
    let Ok(meta) = serde_json::from_str::<QueueWorkerRunMeta>(&raw) else {
        warn!(run_id = %run_id, "[queue_worker_consumer] invalid run meta, acking");
        let _ = msg.ack().await;
        return;
    };

    if meta.status == "cancelled"
        || meta.status == "completed"
        || meta.status == "dead_letter"
    {
        info!(run_id = %run_id, status = %meta.status, "[queue_worker_consumer] run is terminal, acking");
        let _ = msg.ack().await;
        return;
    }

    let attempt = meta.attempt;
    let enqueued_at = meta.enqueued_at;
    let nats_opt = Some(nats.clone());

    let project_uuid = match uuid::Uuid::parse_str(&project_id) {
        Ok(u) => u,
        Err(e) => {
            error!(error = %e, "[queue_worker_consumer] invalid project_id");
            let _ = msg.ack().await;
            return;
        }
    };

    let unit_result = load_unit_for_path_production(
        &pool,
        &redis_conn,
        project_uuid,
        ProjectUnitType::QueueWorker,
        &unit_path,
    )
    .await;

    let source = match unit_result {
        Ok(Some(unit)) => match unit.compiled_code.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(s) => s.to_string(),
            None => {
                error!(run_id = %run_id, "[queue_worker_consumer] unit has no compiled code");
                move_to_dead_letter(
                    &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                    &unit_path, "unit has no compiled code",
                )
                .await;
                let _ = msg.ack().await;
                return;
            }
        },
        Ok(None) => {
            error!(run_id = %run_id, unit_path = %unit_path, "[queue_worker_consumer] unit not found");
            move_to_dead_letter(
                &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                &unit_path, "queue_worker unit not found",
            )
            .await;
            let _ = msg.ack().await;
            return;
        }
        Err(e) => {
            error!(error = %e, run_id = %run_id, "[queue_worker_consumer] load unit error");
            let _ = msg.ack().await;
            return;
        }
    };

    let source_for_meta = source.clone();
    let worker_meta = tokio::task::spawn_blocking(move || extract_worker_metadata(&source_for_meta))
        .await
        .unwrap_or_default();

    if let Some(ref batch_cfg) = worker_meta.batch {
        let batch_cfg = batch_cfg.clone();
        let _ = msg.ack().await;
        handle_batch_item(
            wq_redis, nats_opt, pool, redis_conn, project_id, unit_path,
            run_id, data_json, enqueued_at, attempt, source, batch_cfg, base_url,
        )
        .await;
        return;
    }

    let lock_key = format!("wq:{project_id}:{run_id}:exec_lock");
    let acquired: bool = {
        let mut conn = wq_redis.lock().await;
        redis::cmd("SET")
            .arg(&lock_key)
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(300u64)
            .query_async(&mut *conn)
            .await
            .unwrap_or(false)
    };
    if !acquired {
        info!(run_id = %run_id, "[queue_worker_consumer] exec_lock held, acking");
        let _ = msg.ack().await;
        return;
    }

    {
        let updated = QueueWorkerRunMeta {
            status: "processing".to_string(),
            attempt,
            enqueued_at,
            name: unit_path.clone(),
            run_id: run_id.clone(),
        };
        if let Ok(json) = serde_json::to_string(&updated) {
            let mut conn = wq_redis.lock().await;
            let _: Result<(), _> = conn.set(&meta_key, &json).await;
        }
    }

    publish_qw_event(
        &nats_opt,
        &project_id,
        &run_id,
        "queueWorker.processing",
        serde_json::json!({ "attempt": attempt }),
    )
    .await;

    let timeout_ms = worker_meta.timeout_ms;

    let run_ctx = QueueWorkerRunContext {
        run_id: run_id.clone(),
        attempt,
        enqueued_at,
        data_json,
        project_id: project_id.clone(),
        base_url: base_url.clone(),
    };

    let run_future = tokio::task::spawn_blocking(move || run_worker_handler(&source, &run_ctx));

    let run_result = if let Some(timeout_ms) = timeout_ms {
        match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            run_future,
        )
        .await
        {
            Ok(result) => result,
            Err(_elapsed) => {
                warn!(run_id = %run_id, timeout_ms = timeout_ms, "[queue_worker_consumer] execution timed out");
                let max_attempts = worker_meta.max_attempts.unwrap_or(3);
                if attempt < max_attempts {
                    let next_attempt = attempt + 1;
                    let retry_meta = QueueWorkerRunMeta {
                        status: "retrying".to_string(),
                        attempt: next_attempt,
                        enqueued_at,
                        name: unit_path.clone(),
                        run_id: run_id.clone(),
                    };
                    if let Ok(json) = serde_json::to_string(&retry_meta) {
                        let mut conn = wq_redis.lock().await;
                        let _: Result<(), _> = conn.set(&meta_key, &json).await;
                    }
                    publish_qw_event(
                        &nats_opt, &project_id, &run_id,
                        "queueWorker.retrying",
                        serde_json::json!({ "attempt": next_attempt }),
                    ).await;
                    release_exec_lock(&wq_redis, &lock_key).await;
                    let _ = msg.ack_with(async_nats::jetstream::AckKind::Nak(
                        Some(std::time::Duration::from_millis(200))
                    )).await;
                } else {
                    move_to_dead_letter(
                        &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                        &unit_path, "execution timed out",
                    ).await;
                    release_exec_lock(&wq_redis, &lock_key).await;
                    let _ = msg.ack().await;
                }
                return;
            }
        }
    } else {
        run_future.await
    };

    match run_result {
        Ok(Ok(result)) => {
            let was_cancelled = check_cancelled(&wq_redis, &meta_key).await;
            if was_cancelled {
                release_exec_lock(&wq_redis, &lock_key).await;
                let _ = msg.ack().await;
                return;
            }
            match result.outcome {
                QueueWorkerRunOutcome::Completed(value_json) => {
                    let result_key = format!("wq:{project_id}:{run_id}:result");
                    {
                        let mut conn = wq_redis.lock().await;
                        let _: Result<(), _> = conn.set(&result_key, &value_json).await;
                    }
                    let completed_meta = QueueWorkerRunMeta {
                        status: "completed".to_string(),
                        attempt,
                        enqueued_at,
                        name: unit_path.clone(),
                        run_id: run_id.clone(),
                    };
                    if let Ok(json) = serde_json::to_string(&completed_meta) {
                        let mut conn = wq_redis.lock().await;
                        let _: Result<(), _> = conn.set(&meta_key, &json).await;
                    }
                    let result_val: serde_json::Value = serde_json::from_str(&value_json)
                        .unwrap_or(serde_json::json!(value_json));
                    publish_qw_event(
                        &nats_opt,
                        &project_id,
                        &run_id,
                        "queueWorker.completed",
                        serde_json::json!({ "result": result_val }),
                    )
                    .await;
                    release_exec_lock(&wq_redis, &lock_key).await;
                    let _ = msg.ack().await;
                }
                QueueWorkerRunOutcome::Failed(error_msg) => {
                    process_failed_outcome(
                        &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                        &unit_path, &lock_key, &error_msg, &result.retry_policy,
                        Some(&msg),
                    )
                    .await;
                }
                QueueWorkerRunOutcome::TerminalError(error_msg) => {
                    move_to_dead_letter(
                        &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                        &unit_path, &error_msg,
                    )
                    .await;
                    release_exec_lock(&wq_redis, &lock_key).await;
                    let _ = msg.ack().await;
                }
            }
        }
        Ok(Err(js_error)) => {
            error!(error = %js_error, run_id = %run_id, "[queue_worker_consumer] JS execution error");
            move_to_dead_letter(
                &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                &unit_path, &js_error,
            )
            .await;
            release_exec_lock(&wq_redis, &lock_key).await;
            let _ = msg.ack().await;
        }
        Err(join_error) => {
            error!(error = %join_error, run_id = %run_id, "[queue_worker_consumer] spawn_blocking panicked");
            move_to_dead_letter(
                &wq_redis, &nats_opt, &project_id, &run_id, attempt, enqueued_at,
                &unit_path, "internal execution error",
            )
            .await;
            release_exec_lock(&wq_redis, &lock_key).await;
            let _ = msg.ack().await;
        }
    }
}

async fn check_cancelled(wq_redis: &QueueWorkerRedis, meta_key: &str) -> bool {
    let mut conn = wq_redis.lock().await;
    let raw: Option<String> = conn.get(meta_key).await.unwrap_or(None);
    raw.as_deref()
        .and_then(|s| serde_json::from_str::<QueueWorkerRunMeta>(s).ok())
        .map(|m| m.status == "cancelled")
        .unwrap_or(false)
}

async fn process_failed_outcome(
    wq_redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    run_id: &str,
    attempt: u32,
    enqueued_at: i64,
    unit_path: &str,
    lock_key: &str,
    error_msg: &str,
    policy: &crate::libs::unit_js::queue_worker_runner::QueueWorkerRetryPolicy,
    msg: Option<&async_nats::jetstream::Message>,
) {
    let meta_key = format!("wq:{project_id}:{run_id}:meta");

    publish_qw_event(
        nats,
        project_id,
        run_id,
        "queueWorker.failed",
        serde_json::json!({ "error": error_msg, "attempt": attempt }),
    )
    .await;

    if attempt < policy.max_attempts {
        let next_attempt = attempt + 1;
        let retry_meta = QueueWorkerRunMeta {
            status: "retrying".to_string(),
            attempt: next_attempt,
            enqueued_at,
            name: unit_path.to_string(),
            run_id: run_id.to_string(),
        };
        if let Ok(json) = serde_json::to_string(&retry_meta) {
            let mut conn = wq_redis.lock().await;
            let _: Result<(), _> = conn.set(&meta_key, &json).await;
        }
        publish_qw_event(
            nats,
            project_id,
            run_id,
            "queueWorker.retrying",
            serde_json::json!({ "attempt": next_attempt }),
        )
        .await;
        let delay = queue_worker_backoff_delay(policy, attempt);
        release_exec_lock(wq_redis, lock_key).await;
        if let Some(m) = msg {
            if let Err(e) = m
                .ack_with(async_nats::jetstream::AckKind::Nak(Some(delay)))
                .await
            {
                error!(error = %e, "[queue_worker_consumer] NAK failed");
            }
        }
    } else {
        move_to_dead_letter(wq_redis, nats, project_id, run_id, attempt, enqueued_at, unit_path, error_msg).await;
        release_exec_lock(wq_redis, lock_key).await;
        if let Some(m) = msg {
            let _ = m.ack().await;
        }
    }
}

async fn release_exec_lock(wq_redis: &QueueWorkerRedis, lock_key: &str) {
    let mut conn = wq_redis.lock().await;
    let _: () = redis::cmd("DEL")
        .arg(lock_key)
        .query_async(&mut *conn)
        .await
        .unwrap_or(());
}

async fn move_to_dead_letter(
    wq_redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    run_id: &str,
    attempt: u32,
    enqueued_at: i64,
    unit_path: &str,
    error_msg: &str,
) {
    let meta_key = format!("wq:{project_id}:{run_id}:meta");
    let dl_meta = QueueWorkerRunMeta {
        status: "dead_letter".to_string(),
        attempt,
        enqueued_at,
        name: unit_path.to_string(),
        run_id: run_id.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&dl_meta) {
        let mut conn = wq_redis.lock().await;
        let _: Result<(), _> = conn.set(&meta_key, &json).await;
    }
    publish_qw_event(
        nats,
        project_id,
        run_id,
        "queueWorker.dead_letter",
        serde_json::json!({ "error": error_msg }),
    )
    .await;
}

// ---------------------------------------------------------------------------
// Batch mode
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct BatchItem {
    run_id: String,
    data: String,
    enqueued_at: i64,
}

async fn handle_batch_item(
    wq_redis: QueueWorkerRedis,
    nats: Option<async_nats::Client>,
    _pool: DbPool,
    _redis_conn: crate::database::SharedRedisConn,
    project_id: String,
    unit_path: String,
    run_id: String,
    data_json: String,
    enqueued_at: i64,
    _attempt: u32,
    source: String,
    batch_cfg: BatchConfig,
    base_url: String,
) {
    let batch_key = format!("wq:{project_id}:{unit_path}:batch_items");
    let item = BatchItem {
        run_id,
        data: data_json,
        enqueued_at,
    };
    let item_json = match serde_json::to_string(&item) {
        Ok(j) => j,
        Err(e) => {
            error!(error = %e, "[batch] failed to serialize batch item");
            return;
        }
    };

    let (new_len, should_dispatch_now) = {
        let mut conn = wq_redis.lock().await;
        let new_len: i64 = redis::cmd("RPUSH")
            .arg(&batch_key)
            .arg(&item_json)
            .query_async(&mut *conn)
            .await
            .unwrap_or(0);
        let should = new_len >= batch_cfg.size as i64;
        (new_len, should)
    };

    if should_dispatch_now {
        let items = batch_pop_all(&wq_redis, &batch_key).await;
        if !items.is_empty() {
            dispatch_batch(
                wq_redis, nats, project_id, unit_path,
                source, items, 1, base_url,
            )
            .await;
        }
        return;
    }

    if new_len == 1 {
        let wq_redis_t = wq_redis.clone();
        let nats_t = nats.clone();
        let project_id_t = project_id.clone();
        let unit_path_t = unit_path.clone();
        let source_t = source.clone();
        let base_url_t = base_url.clone();
        let timeout_ms = batch_cfg.timeout_ms;

        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
            let items = batch_pop_all(&wq_redis_t, &format!("wq:{project_id_t}:{unit_path_t}:batch_items")).await;
            if !items.is_empty() {
                dispatch_batch(
                    wq_redis_t, nats_t, project_id_t, unit_path_t,
                    source_t, items, 1, base_url_t,
                )
                .await;
            }
        });
    }
}

async fn batch_pop_all(wq_redis: &QueueWorkerRedis, batch_key: &str) -> Vec<BatchItem> {
    let mut conn = wq_redis.lock().await;
    let raw_items: Vec<String> = redis::cmd("LRANGE")
        .arg(batch_key)
        .arg(0i64)
        .arg(-1i64)
        .query_async(&mut *conn)
        .await
        .unwrap_or_default();
    if !raw_items.is_empty() {
        let _: () = redis::cmd("DEL")
            .arg(batch_key)
            .query_async(&mut *conn)
            .await
            .unwrap_or(());
    }
    raw_items
        .iter()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect()
}

async fn dispatch_batch(
    wq_redis: QueueWorkerRedis,
    nats: Option<async_nats::Client>,
    project_id: String,
    unit_path: String,
    source: String,
    items: Vec<BatchItem>,
    initial_attempt: u32,
    base_url: String,
) {
    if items.is_empty() {
        return;
    }

    let primary_run_id = items[0].run_id.clone();
    let enqueued_at = items[0].enqueued_at;
    let nats_opt = nats;
    let all_run_ids: Vec<String> = items.iter().map(|i| i.run_id.clone()).collect();

    let batch_data: Vec<serde_json::Value> = items
        .iter()
        .map(|item| serde_json::from_str(&item.data).unwrap_or(serde_json::json!({})))
        .collect();
    let batch_data_json = serde_json::to_string(&batch_data).unwrap_or_else(|_| "[]".to_string());

    let max_attempts = {
        batch_mark_processing(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt, enqueued_at).await;

        let run_ctx = QueueWorkerRunContext {
            run_id: primary_run_id.clone(),
            attempt: initial_attempt,
            enqueued_at,
            data_json: batch_data_json.clone(),
            project_id: project_id.clone(),
            base_url: base_url.clone(),
        };
        let src = source.clone();
        let first_result = tokio::task::spawn_blocking(move || run_worker_handler(&src, &run_ctx)).await;
        match first_result {
            Ok(Ok(r)) => {
                let max = r.retry_policy.max_attempts;
                match r.outcome {
                    QueueWorkerRunOutcome::Completed(value_json) => {
                        batch_complete(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt, enqueued_at, &value_json).await;
                        return;
                    }
                    QueueWorkerRunOutcome::TerminalError(msg) => {
                        batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt, enqueued_at, &msg).await;
                        return;
                    }
                    QueueWorkerRunOutcome::Failed(msg) => {
                        if initial_attempt >= max {
                            batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt, enqueued_at, &msg).await;
                            return;
                        }
                        batch_mark_retrying(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt + 1, enqueued_at).await;
                        let delay = crate::libs::unit_js::queue_worker_runner::QueueWorkerRetryPolicy::default();
                        tokio::time::sleep(queue_worker_backoff_delay(&delay, initial_attempt)).await;
                        max
                    }
                }
            }
            Ok(Err(js_error)) => {
                error!(error = %js_error, "[batch] JS execution error");
                batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt, enqueued_at, &js_error).await;
                return;
            }
            Err(join_error) => {
                error!(error = %join_error, "[batch] spawn_blocking panicked");
                batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, initial_attempt, enqueued_at, "internal batch execution error").await;
                return;
            }
        }
    };

    let mut attempt = initial_attempt + 1;
    loop {
        let run_ctx = QueueWorkerRunContext {
            run_id: primary_run_id.clone(),
            attempt,
            enqueued_at,
            data_json: batch_data_json.clone(),
            project_id: project_id.clone(),
            base_url: base_url.clone(),
        };
        let src = source.clone();

        batch_mark_processing(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt, enqueued_at).await;

        let run_result = tokio::task::spawn_blocking(move || run_worker_handler(&src, &run_ctx)).await;

        match run_result {
            Ok(Ok(r)) => match r.outcome {
                QueueWorkerRunOutcome::Completed(value_json) => {
                    batch_complete(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt, enqueued_at, &value_json).await;
                    return;
                }
                QueueWorkerRunOutcome::TerminalError(msg) => {
                    batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt, enqueued_at, &msg).await;
                    return;
                }
                QueueWorkerRunOutcome::Failed(msg) => {
                    if attempt >= max_attempts {
                        batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt, enqueued_at, &msg).await;
                        return;
                    }
                    batch_mark_retrying(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt + 1, enqueued_at).await;
                    let default_policy = crate::libs::unit_js::queue_worker_runner::QueueWorkerRetryPolicy::default();
                    tokio::time::sleep(queue_worker_backoff_delay(&default_policy, attempt)).await;
                    attempt += 1;
                }
            },
            Ok(Err(js_error)) => {
                error!(error = %js_error, "[batch] JS execution error");
                batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt, enqueued_at, &js_error).await;
                return;
            }
            Err(join_error) => {
                error!(error = %join_error, "[batch] spawn_blocking panicked");
                batch_dead_letter(&wq_redis, &nats_opt, &project_id, &unit_path, &all_run_ids, attempt, enqueued_at, "internal batch execution error").await;
                return;
            }
        }
    }
}

async fn batch_mark_processing(
    wq_redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    run_ids: &[String],
    attempt: u32,
    enqueued_at: i64,
) {
    for run_id in run_ids {
        let meta_key = format!("wq:{project_id}:{run_id}:meta");
        let meta = QueueWorkerRunMeta {
            status: "processing".to_string(),
            attempt,
            enqueued_at,
            name: unit_path.to_string(),
            run_id: run_id.clone(),
        };
        if let Ok(json) = serde_json::to_string(&meta) {
            let mut conn = wq_redis.lock().await;
            let _: Result<(), _> = conn.set(&meta_key, &json).await;
        }
        publish_qw_event(nats, project_id, run_id, "queueWorker.processing", serde_json::json!({ "attempt": attempt })).await;
    }
}

async fn batch_mark_retrying(
    wq_redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    run_ids: &[String],
    next_attempt: u32,
    enqueued_at: i64,
) {
    for run_id in run_ids {
        let meta_key = format!("wq:{project_id}:{run_id}:meta");
        let meta = QueueWorkerRunMeta {
            status: "retrying".to_string(),
            attempt: next_attempt,
            enqueued_at,
            name: unit_path.to_string(),
            run_id: run_id.clone(),
        };
        if let Ok(json) = serde_json::to_string(&meta) {
            let mut conn = wq_redis.lock().await;
            let _: Result<(), _> = conn.set(&meta_key, &json).await;
        }
        publish_qw_event(nats, project_id, run_id, "queueWorker.retrying", serde_json::json!({ "attempt": next_attempt })).await;
    }
}

async fn batch_complete(
    wq_redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    run_ids: &[String],
    attempt: u32,
    enqueued_at: i64,
    value_json: &str,
) {
    for run_id in run_ids {
        let result_key = format!("wq:{project_id}:{run_id}:result");
        let meta_key = format!("wq:{project_id}:{run_id}:meta");
        {
            let mut conn = wq_redis.lock().await;
            let _: Result<(), _> = conn.set(&result_key, value_json).await;
        }
        let meta = QueueWorkerRunMeta {
            status: "completed".to_string(),
            attempt,
            enqueued_at,
            name: unit_path.to_string(),
            run_id: run_id.clone(),
        };
        if let Ok(json) = serde_json::to_string(&meta) {
            let mut conn = wq_redis.lock().await;
            let _: Result<(), _> = conn.set(&meta_key, &json).await;
        }
        let result_val: serde_json::Value = serde_json::from_str(value_json)
            .unwrap_or(serde_json::json!(value_json));
        publish_qw_event(nats, project_id, run_id, "queueWorker.completed", serde_json::json!({ "result": result_val })).await;
    }
}

async fn batch_dead_letter(
    wq_redis: &QueueWorkerRedis,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    run_ids: &[String],
    attempt: u32,
    enqueued_at: i64,
    error_msg: &str,
) {
    for run_id in run_ids {
        move_to_dead_letter(wq_redis, nats, project_id, run_id, attempt, enqueued_at, unit_path, error_msg).await;
    }
}

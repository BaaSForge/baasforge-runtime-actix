use crate::libs::unit_js::actor_runner::{
    ActorCtxJson, ActorKind, ActorMetadata, ActorOutcome, actor_backoff_delay,
    extract_actor_metadata_cached, run_actor_handler,
};
use crate::libs::unit_js::modules::sdk::{SdkActorLocks, SdkCommCtx};
use crate::models::actor_store;
use crate::models::projects::ProjectUnitType;
use crate::services::actor_engine::{
    ActorRedis, bump_actor_last_access_if_present, cancel_alarm, clear_actor_idle_deadline, commit_state,
    delete_actor_state, evict_actor_hot_cache_keep_alarms, idle_due_member, load_hot_state, publish_actor_event,
    refresh_actor_idle_deadline, set_alarm, ACTOR_IDLE_DUE_ZSET,
};
use crate::services::project_release::{
    load_live_release_id_scoped, load_production_runtime_id_for_project, load_unit_for_path_scoped,
};
use chrono::Utc;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::{error, warn};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use uuid::Uuid;

fn actor_handler_payload_preview(payload_json: &str) -> String {
    let normalized = serde_json::from_str::<Value>(payload_json)
        .map(|v| crate::libs::string::json_value_preview_for_log(&v))
        .unwrap_or_else(|_| crate::libs::string::truncate_chars_for_log(payload_json));
    normalized
}

async fn sync_idle_tracker_after_touch(
    redis: &ActorRedis,
    metadata: &ActorMetadata,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) {
    if let Some(ms) = metadata.max_idle_time_ms.filter(|m| *m > 0) {
        refresh_actor_idle_deadline(redis, project_id, stage_runtime_id, unit_path, actor_id, ms).await;
    } else {
        clear_actor_idle_deadline(redis, project_id, stage_runtime_id, unit_path, actor_id).await;
    }
}

pub struct ActorRunInput {
    pub project_id: String,
    pub unit_path: String,
    pub actor_id: String,
    pub handler: String,
    pub payload_json: String,
    pub kind: ActorKind,
    pub alarm_name: Option<String>,
    pub error_msg: Option<String>,
}

pub struct ActorRunOutput {
    pub result: Value,
    pub error: Option<String>,
    pub state_touched: bool,
}

pub async fn run_actor_with_lock(
    input: ActorRunInput,
    comm: Arc<SdkCommCtx>,
    precomputed_scope_trace_ids: Option<crate::telemetry::BaalHttpTriggerTraceIds>,
) -> Result<ActorRunOutput, String> {
    crate::rt_enter!(
        "actor.run_with_lock",
        project_id = %input.project_id,
        unit_path = %input.unit_path,
        actor_id = %input.actor_id,
        handler = %input.handler,
        kind = ?input.kind,
        stage = comm.stage_runtime_id.is_some()
    );
    let actor_redis = comm.actor_redis.clone();

    let lock_key = (
        input.project_id.clone(),
        input.unit_path.clone(),
        input.actor_id.clone(),
        comm.stage_runtime_id,
    );

    let actor_mutex = {
        let mut map = comm.actor_locks.lock().await;
        map.entry(lock_key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };

    crate::rt_step!(
        "actor.run_with_lock.acquire",
        actor_id = %input.actor_id,
        unit_path = %input.unit_path
    );
    let _guard = actor_mutex.lock().await;
    crate::rt_step!(
        "actor.run_with_lock.acquired",
        actor_id = %input.actor_id,
        unit_path = %input.unit_path
    );

    let out = run_actor_inner(input, actor_redis, comm, precomputed_scope_trace_ids).await;
    match &out {
        Ok(_) => crate::rt_exit_ok!("actor.run_with_lock"),
        Err(e) => crate::rt_exit_err!("actor.run_with_lock", error = %e),
    }
    out
}

async fn run_actor_inner(
    input: ActorRunInput,
    actor_redis: ActorRedis,
    comm: Arc<SdkCommCtx>,
    precomputed_scope_trace_ids: Option<crate::telemetry::BaalHttpTriggerTraceIds>,
) -> Result<ActorRunOutput, String> {
    let nats = comm.actor_nats.clone();
    let project_uuid = Uuid::parse_str(&input.project_id)
        .map_err(|e| format!("invalid project_id: {e}"))?;

    let unit_result = load_unit_for_path_scoped(
        &comm.pool,
        &comm.redis_conn,
        project_uuid,
        comm.stage_runtime_id,
        ProjectUnitType::Actor,
        &input.unit_path,
    )
    .await;

    let unit = match unit_result {
        Ok(Some(u)) => u,
        Ok(None) => return Err(format!("actor unit not found: {}", input.unit_path)),
        Err(e) => return Err(format!("load actor unit error: {e}")),
    };

    let source = match unit.compiled_code.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(s) => s.to_string(),
        None => return Err("actor unit has no compiled code".to_string()),
    };

    let source = match crate::libs::unit_js::prepare_source_scoped(&source, &comm.pool, &comm.redis_conn, project_uuid, comm.stage_runtime_id).await {
        Ok(s) => s,
        Err(crate::libs::unit_js::PrepareError::WrongImport) => {
            return Err(crate::libs::unit_js::WRONG_IMPORT_MSG.to_string());
        }
        Err(crate::libs::unit_js::PrepareError::UnnamedImport) => {
            return Err(crate::libs::unit_js::UNNAMED_IMPORT_MSG.to_string());
        }
        Err(crate::libs::unit_js::PrepareError::Load(e)) => return Err(e),
    };

    let (resolved_runtime_id, live_release_id) = if let Some(ids) = precomputed_scope_trace_ids {
        (ids.runtime_id, ids.release_id)
    } else {
        let resolved_runtime_id = match comm.stage_runtime_id {
            Some(rid) => Some(rid),
            None => load_production_runtime_id_for_project(&comm.pool, project_uuid)
                .await
                .ok()
                .flatten(),
        };
        let live_release_id = load_live_release_id_scoped(
            &comm.pool,
            &comm.redis_conn,
            project_uuid,
            comm.stage_runtime_id,
        )
        .await
        .ok()
        .flatten();
        (resolved_runtime_id, live_release_id)
    };

    let trace_ids = crate::telemetry::BaalHttpTriggerTraceIds {
        release_id: live_release_id,
        runtime_id: resolved_runtime_id,
    };
    let cur = tracing::Span::current();
    if let Some(rid) = trace_ids.runtime_id {
        cur.record("baal.runtime.id", tracing::field::display(rid));
    }
    if let Some(rel) = trace_ids.release_id {
        cur.record("baal.release.id", tracing::field::display(rel));
    }

    let metadata: ActorMetadata = extract_actor_metadata_cached(&source).await;

    if input.kind == ActorKind::Handler && !metadata.handlers.is_empty() {
        if !metadata.handlers.contains(&input.handler) {
            return Err(format!("UnknownHandler: '{}' is not in allowlist", input.handler));
        }
    }

    let retry_policy = metadata.retry.clone().unwrap_or_default();
    let state_limit = metadata.state_limit_bytes;

    let (loaded_state, loaded_version) =
        match load_hot_state(
            &actor_redis,
            &input.project_id,
            comm.stage_runtime_id,
            &input.unit_path,
            &input.actor_id,
        )
        .await
        {
            Some((s, v)) => (Some(s), v),
            None => {
                if let Some(pool) = &comm.actor_pg {
                    match actor_store::load_snapshot(
                        pool,
                        &input.project_id,
                        &input.unit_path,
                        &input.actor_id,
                        comm.stage_runtime_id,
                    )
                    .await
                    {
                        Ok(Some((s, v))) => {
                            let _ = commit_state(
                                &actor_redis,
                                &input.project_id,
                                comm.stage_runtime_id,
                                &input.unit_path,
                                &input.actor_id,
                                &s,
                                v,
                            )
                            .await;
                            sync_idle_tracker_after_touch(
                                &actor_redis,
                                &metadata,
                                &input.project_id,
                                comm.stage_runtime_id,
                                &input.unit_path,
                                &input.actor_id,
                            )
                            .await;
                            (Some(s), v)
                        }
                        Ok(None) => (None, 0),
                        Err(e) => return Err(e),
                    }
                } else {
                    (None, 0)
                }
            }
        };

    let mut attempt: u32 = 1;
    let mut retry_state: Option<Value> = None;
    loop {
        let state_for_attempt = retry_state.clone().or_else(|| loaded_state.clone());
        let ctx_json = ActorCtxJson {
            actor_id: input.actor_id.clone(),
            attempt,
            state: state_for_attempt,
            handler: input.handler.clone(),
            payload_json: input.payload_json.clone(),
            kind: input.kind.clone(),
            alarm_name: input.alarm_name.clone(),
            error_msg: input.error_msg.clone(),
        };

        let src = source.clone();
        let limit = state_limit;
        let timeout = metadata.timeout;
        let comm_for_spawn = comm.for_unit(
            input.project_id.clone(),
            input.unit_path.clone(),
            None,
        );
        let rid_owned = resolved_runtime_id.map(|u| u.to_string());
        let trigger_runtime = if comm.stage_runtime_id.is_some() {
            Some("stage")
        } else {
            Some("production")
        };
        let env_label: &'static str = if comm.stage_runtime_id.is_some() {
            "stage"
        } else {
            "production"
        };
        let handler_payload_preview = actor_handler_payload_preview(&input.payload_json);
        let handler_span = tracing::info_span!(
            "actor.handler.invoke",
            baal.project.id = %input.project_id,
            baal.app.environment = env_label,
            baal.unit.path = %input.unit_path,
            baal.actor.instance_id = %input.actor_id,
            baal.actor.handler = %input.handler,
            baal.actor.handler_payload = %handler_payload_preview,
            attempt,
            baal.runtime.id = tracing::field::Empty,
            baal.release.id = tracing::field::Empty,
        );
        if let Some(r) = resolved_runtime_id {
            handler_span.record("baal.runtime.id", tracing::field::display(r));
        }
        if let Some(rel) = live_release_id {
            handler_span.record("baal.release.id", tracing::field::display(rel));
        }
        handler_span.set_parent(tracing::Span::current().context());
        let parent_ctx = crate::telemetry::context_with_telemetry_baggage(
            handler_span.context(),
            Some(input.project_id.as_str()),
            trigger_runtime,
            rid_owned.as_deref(),
        );

        drop(parent_ctx.attach());
        let outcome = run_actor_handler(&src, &ctx_json, comm_for_spawn, limit, timeout)
            .await
            .map_err(|e| format!("actor JS error: {e}"))?;

        match outcome {
            ActorOutcome::Completed {
                new_state,
                result,
                state_touched,
                pending_alarms,
                cancelled_alarms,
            } => {
                if state_touched {
                    let new_version = loaded_version + attempt as i64;
                    commit_state(
                        &actor_redis,
                        &input.project_id,
                        comm.stage_runtime_id,
                        &input.unit_path,
                        &input.actor_id,
                        &new_state,
                        new_version,
                    )
                    .await?;
                    sync_idle_tracker_after_touch(
                        &actor_redis,
                        &metadata,
                        &input.project_id,
                        comm.stage_runtime_id,
                        &input.unit_path,
                        &input.actor_id,
                    )
                    .await;
                    if let Some(pool) = &comm.actor_pg {
                        if let Err(e) = actor_store::upsert_snapshot(
                            pool,
                            &input.project_id,
                            &input.unit_path,
                            &input.actor_id,
                            comm.stage_runtime_id,
                            &new_state,
                            new_version,
                        )
                        .await
                        {
                            error!(error = %e, "[actor_manager] upsert_snapshot failed");
                        }
                    }
                } else if bump_actor_last_access_if_present(
                    &actor_redis,
                    &input.project_id,
                    comm.stage_runtime_id,
                    &input.unit_path,
                    &input.actor_id,
                )
                .await
                {
                    sync_idle_tracker_after_touch(
                        &actor_redis,
                        &metadata,
                        &input.project_id,
                        comm.stage_runtime_id,
                        &input.unit_path,
                        &input.actor_id,
                    )
                    .await;
                }

                let cancelled_names: HashSet<&str> =
                    cancelled_alarms.iter().map(|n| n.as_str()).collect();
                for name in &cancelled_alarms {
                    cancel_alarm(
                        &actor_redis,
                        &input.project_id,
                        comm.stage_runtime_id,
                        &input.unit_path,
                        &input.actor_id,
                        name,
                    )
                    .await;
                }
                let mut pending_by_name: HashMap<&str, &crate::libs::unit_js::actor_runner::PendingAlarm> =
                    HashMap::new();
                for alarm in &pending_alarms {
                    pending_by_name.insert(alarm.name.as_str(), alarm);
                }
                for alarm in pending_by_name.into_values() {
                    if cancelled_names.contains(alarm.name.as_str()) {
                        continue;
                    }
                    let fire_at_ms = if alarm.relative {
                        Utc::now().timestamp_millis().saturating_add(alarm.at)
                    } else {
                        alarm.at
                    };
                    set_alarm(
                        &actor_redis,
                        &input.project_id,
                        comm.stage_runtime_id,
                        &input.unit_path,
                        &input.actor_id,
                        &alarm.name,
                        fire_at_ms,
                    )
                    .await;
                }

                if attempt == 1 {
                    publish_actor_event(
                        &nats,
                        &input.project_id,
                        &input.unit_path,
                        &input.actor_id,
                        "activated",
                        comm.stage_runtime_id,
                    )
                    .await;
                }

                return Ok(ActorRunOutput {
                    result,
                    error: None,
                    state_touched,
                });
            }

            ActorOutcome::UnknownHandler(msg) => {
                return Err(format!("UnknownHandler: {msg}"));
            }

            ActorOutcome::StateLimitExceeded(msg) => {
                return Ok(ActorRunOutput {
                    result: Value::Object({
                        let mut m = serde_json::Map::new();
                        m.insert("error".to_string(), Value::String(msg));
                        m
                    }),
                    error: None,
                    state_touched: false,
                });
            }

            ActorOutcome::Terminal { error, state } => {
                run_dead_letter(
                    &source,
                    &input,
                    attempt,
                    &error,
                    state,
                    loaded_version,
                    &actor_redis,
                    &nats,
                    state_limit,
                    comm.clone(),
                )
                .await;

                publish_actor_event(
                    &nats,
                    &input.project_id,
                    &input.unit_path,
                    &input.actor_id,
                    "failed",
                    comm.stage_runtime_id,
                )
                .await;

                return Ok(ActorRunOutput {
                    result: serde_json::json!({ "error": error }),
                    error: Some(error),
                    state_touched: false,
                });
            }

            ActorOutcome::Retriable(error, modified_state) => {
                retry_state = modified_state;
                if attempt >= retry_policy.max_attempts {
                    run_dead_letter(
                        &source,
                        &input,
                        attempt,
                        &error,
                        None,
                        loaded_version,
                        &actor_redis,
                        &nats,
                        state_limit,
                        comm.clone(),
                    )
                    .await;

                    publish_actor_event(
                        &nats,
                        &input.project_id,
                        &input.unit_path,
                        &input.actor_id,
                        "failed",
                        comm.stage_runtime_id,
                    )
                    .await;

                    return Ok(ActorRunOutput {
                        result: serde_json::json!({ "error": error }),
                        error: Some(error),
                        state_touched: false,
                    });
                }

                let delay = actor_backoff_delay(&retry_policy, attempt);
                warn!(
                    actor_id = %input.actor_id,
                    attempt = attempt,
                    error = %error,
                    delay_ms = delay.as_millis(),
                    "[actor_manager] retrying"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_dead_letter(
    source: &str,
    input: &ActorRunInput,
    attempt: u32,
    error: &str,
    _state: Option<Value>,
    loaded_version: i64,
    actor_redis: &ActorRedis,
    nats: &Option<async_nats::Client>,
    state_limit: Option<u64>,
    comm: Arc<SdkCommCtx>,
) {
    let loaded_state = load_hot_state(
        actor_redis,
        &input.project_id,
        comm.stage_runtime_id,
        &input.unit_path,
        &input.actor_id,
    )
    .await
    .map(|(s, _)| s);

    let dl_ctx = ActorCtxJson {
        actor_id: input.actor_id.clone(),
        attempt,
        state: loaded_state,
        handler: input.handler.clone(),
        payload_json: input.payload_json.clone(),
        kind: ActorKind::DeadLetter,
        alarm_name: None,
        error_msg: Some(error.to_string()),
    };

    let src = source.to_string();
    let limit = state_limit;
    let comm_for_spawn = comm.for_unit(
        input.project_id.clone(),
        input.unit_path.clone(),
        None,
    );
    let project_uuid_dl = match Uuid::parse_str(&input.project_id) {
        Ok(u) => u,
        Err(_) => {
            warn!(project_id = %input.project_id, "[actor_manager] dead_letter: invalid project_id");
            return;
        }
    };
    let resolved_runtime_id_dl = match comm.stage_runtime_id {
        Some(rid) => Some(rid),
        None => load_production_runtime_id_for_project(&comm.pool, project_uuid_dl)
            .await
            .ok()
            .flatten(),
    };
    let live_release_id_dl = load_live_release_id_scoped(
        &comm.pool,
        &comm.redis_conn,
        project_uuid_dl,
        comm.stage_runtime_id,
    )
    .await
    .ok()
    .flatten();
    let rid_owned_dl = resolved_runtime_id_dl.map(|u| u.to_string());
    let trigger_runtime_dl = if comm.stage_runtime_id.is_some() {
        Some("stage")
    } else {
        Some("production")
    };
    let env_dl: &'static str = if comm.stage_runtime_id.is_some() {
        "stage"
    } else {
        "production"
    };
    let dl_payload_preview = actor_handler_payload_preview(&input.payload_json);
    let dl_span = tracing::info_span!(
        "actor.handler.dead_letter",
        baal.project.id = %input.project_id,
        baal.app.environment = env_dl,
        baal.unit.path = %input.unit_path,
        baal.actor.instance_id = %input.actor_id,
        baal.actor.handler = %input.handler,
        baal.actor.handler_payload = %dl_payload_preview,
        attempt,
        baal.runtime.id = tracing::field::Empty,
        baal.release.id = tracing::field::Empty,
    );
    if let Some(r) = resolved_runtime_id_dl {
        dl_span.record("baal.runtime.id", tracing::field::display(r));
    }
    if let Some(rel) = live_release_id_dl {
        dl_span.record("baal.release.id", tracing::field::display(rel));
    }
    dl_span.set_parent(tracing::Span::current().context());
    let parent_ctx = crate::telemetry::context_with_telemetry_baggage(
        dl_span.context(),
        Some(input.project_id.as_str()),
        trigger_runtime_dl,
        rid_owned_dl.as_deref(),
    );

    drop(parent_ctx.attach());
    let outcome = run_actor_handler(&src, &dl_ctx, comm_for_spawn, limit, None).await;

    match outcome {
        Ok(ActorOutcome::Completed { new_state, state_touched, .. }) => {
            if state_touched {
                let new_version = loaded_version + attempt as i64 + 1;
                if let Err(e) = commit_state(
                    actor_redis,
                    &input.project_id,
                    comm.stage_runtime_id,
                    &input.unit_path,
                    &input.actor_id,
                    &new_state,
                    new_version,
                )
                .await
                {
                    error!(error = %e, "[actor_manager] dead_letter state commit failed");
                } else if let Some(pool) = &comm.actor_pg {
                    if let Err(e) = actor_store::upsert_snapshot(
                        pool,
                        &input.project_id,
                        &input.unit_path,
                        &input.actor_id,
                        comm.stage_runtime_id,
                        &new_state,
                        new_version,
                    )
                    .await
                    {
                        error!(error = %e, "[actor_manager] dead_letter upsert_snapshot failed");
                    }
                }
            }
        }
        Ok(ActorOutcome::Retriable(e, _)) | Ok(ActorOutcome::Terminal { error: e, .. }) => {
            warn!(error = %e, "[actor_manager] dead_letter JS error")
        }
        Err(e) => warn!(error = %e, "[actor_manager] dead_letter JS error"),
        _ => {}
    }

    publish_actor_event(
        nats,
        &input.project_id,
        &input.unit_path,
        &input.actor_id,
        "dead_letter",
        comm.stage_runtime_id,
    )
    .await;
}

pub async fn passivate_actor(
    actor_redis: &ActorRedis,
    actor_pg: Option<&actor_store::ActorPgPool>,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    stage_runtime_id: Option<Uuid>,
    skip_if_idle_rescheduled: bool,
    locks: Option<&SdkActorLocks>,
) {
    let actor_exec_arc = if let Some(locks) = locks {
        let lock_key = (
            project_id.to_string(),
            unit_path.to_string(),
            actor_id.to_string(),
            stage_runtime_id,
        );
        let mut map = locks.lock().await;
        Some(
            map.entry(lock_key)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone(),
        )
    } else {
        None
    };
    let _actor_exec_guard = if let Some(ref arc) = actor_exec_arc {
        Some(arc.lock().await)
    } else {
        None
    };

    if skip_if_idle_rescheduled {
        let member = idle_due_member(stage_runtime_id, project_id, unit_path, actor_id);
        let now_ms = chrono::Utc::now().timestamp_millis() as f64;
        let mut conn = actor_redis.clone();
        let score: Option<f64> = redis::cmd("ZSCORE")
            .arg(ACTOR_IDLE_DUE_ZSET)
            .arg(&member)
            .query_async(&mut conn)
            .await
            .ok()
            .flatten();
        if score.map(|s| s > now_ms).unwrap_or(true) {
            return;
        }
    }

    clear_actor_idle_deadline(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await;

    if let Some((state, version)) =
        load_hot_state(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await
    {
        if let Some(pool) = actor_pg {
            if let Err(e) =
                actor_store::upsert_snapshot(pool, project_id, unit_path, actor_id, stage_runtime_id, &state, version)
                    .await
            {
                error!(error = %e, "[actor_manager] passivate upsert_snapshot failed");
            }
        }
        evict_actor_hot_cache_keep_alarms(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await;
    }

    publish_actor_event(
        nats,
        project_id,
        unit_path,
        actor_id,
        "passivated",
        stage_runtime_id,
    )
    .await;
}

pub async fn delete_actor(
    actor_redis: &ActorRedis,
    actor_pg: Option<&actor_store::ActorPgPool>,
    nats: &Option<async_nats::Client>,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    locks: Option<&SdkActorLocks>,
) {
    let actor_exec_arc = if let Some(locks) = locks {
        let lock_key = (
            project_id.to_string(),
            unit_path.to_string(),
            actor_id.to_string(),
            stage_runtime_id,
        );
        let mut map = locks.lock().await;
        Some(
            map.entry(lock_key)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone(),
        )
    } else {
        None
    };
    let _actor_exec_guard = if let Some(ref arc) = actor_exec_arc {
        Some(arc.lock().await)
    } else {
        None
    };

    clear_actor_idle_deadline(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await;
    if let Some(pool) = actor_pg {
        let _ = actor_store::delete_snapshot(pool, project_id, unit_path, actor_id, stage_runtime_id).await;
    }
    delete_actor_state(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await;
    let _ = nats;
}

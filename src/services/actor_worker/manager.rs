use crate::libs::unit_js::actor_runner::{
    ActorCtxJson, ActorKind, ActorMetadata, ActorOutcome, actor_backoff_delay,
    extract_actor_metadata, run_actor_handler,
};
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::models::actor_store;
use crate::models::projects::ProjectUnitType;
use crate::services::actor_engine::{
    ActorRedis, cancel_alarm, commit_state, delete_actor_state, load_hot_state,
    publish_actor_event, set_alarm,
};
use crate::services::project_release::load_unit_for_path_scoped;
use chrono::Utc;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use tracing::{error, warn};
use uuid::Uuid;

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
) -> Result<ActorRunOutput, String> {
    let actor_redis = comm
        .actor_redis
        .clone()
        .ok_or_else(|| "actor_redis not configured".to_string())?;

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

    let _guard = actor_mutex.lock().await;

    run_actor_inner(input, actor_redis, comm).await
}

async fn run_actor_inner(
    input: ActorRunInput,
    actor_redis: ActorRedis,
    comm: Arc<SdkCommCtx>,
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

    let source_for_meta = source.clone();
    let metadata: ActorMetadata =
        tokio::task::spawn_blocking(move || extract_actor_metadata(&source_for_meta))
            .await
            .unwrap_or_default();

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

        let outcome =
            tokio::task::spawn_blocking(move || run_actor_handler(&src, &ctx_json, comm_for_spawn, limit, timeout))
                .await
                .map_err(|e| format!("spawn_blocking panicked: {e}"))?
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
                    if let Some(pool) = &comm.actor_pg {
                        let pool = pool.clone();
                        let pid = input.project_id.clone();
                        let up = input.unit_path.clone();
                        let aid = input.actor_id.clone();
                        let st = new_state.clone();
                        let stage = comm.stage_runtime_id;
                        tokio::spawn(async move {
                            if let Err(e) =
                                actor_store::upsert_snapshot(&pool, &pid, &up, &aid, stage, &st, new_version)
                                    .await
                            {
                                error!(error = %e, "[actor_manager] upsert_snapshot failed");
                            }
                        });
                    }
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
                for alarm in &pending_alarms {
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

    let outcome = tokio::task::spawn_blocking(move || {
        run_actor_handler(&src, &dl_ctx, comm_for_spawn, limit, None)
    })
    .await;

    match outcome {
        Ok(Ok(ActorOutcome::Completed { new_state, state_touched, .. })) => {
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
                    let pool = pool.clone();
                    let pid = input.project_id.clone();
                    let up = input.unit_path.clone();
                    let aid = input.actor_id.clone();
                    let st = new_state.clone();
                    let stage = comm.stage_runtime_id;
                    tokio::spawn(async move {
                        if let Err(e) =
                            actor_store::upsert_snapshot(&pool, &pid, &up, &aid, stage, &st, new_version).await
                        {
                            error!(error = %e, "[actor_manager] dead_letter upsert_snapshot failed");
                        }
                    });
                }
            }
        }
        Ok(Err(e)) => warn!(error = %e, "[actor_manager] dead_letter JS error"),
        Err(e) => warn!(error = %e, "[actor_manager] dead_letter spawn_blocking panicked"),
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
) {
    if let Some(pool) = actor_pg {
        if let Some((state, version)) =
            load_hot_state(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await
        {
            if let Err(e) =
                actor_store::upsert_snapshot(pool, project_id, unit_path, actor_id, stage_runtime_id, &state, version)
                    .await
            {
                error!(error = %e, "[actor_manager] passivate upsert_snapshot failed");
            }
        }
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
) {
    if let Some(pool) = actor_pg {
        let _ = actor_store::delete_snapshot(pool, project_id, unit_path, actor_id, stage_runtime_id).await;
    }
    delete_actor_state(actor_redis, project_id, stage_runtime_id, unit_path, actor_id).await;
    let _ = nats;
}

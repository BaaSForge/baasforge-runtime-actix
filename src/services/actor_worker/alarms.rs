use crate::libs::unit_js::actor_runner::ActorKind;
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::services::actor_engine::{cancel_alarm, pop_due_alarms, restore_alarm_to_global, ActorRedis};
use crate::services::actor_worker::manager::{ActorRunInput, run_actor_with_lock};
use crate::services::project_release::load_live_release_id_scoped;
use crate::telemetry::{async_consumer_context, AsyncConsumerSpanExtras, TriggerCorrelation};
use opentelemetry::trace::FutureExt;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::warn;

const MAX_CONCURRENT_ALARM_RUNS: usize = 64;

async fn dispatch_one_alarm(
    actor_redis: ActorRedis,
    comm: Arc<SdkCommCtx>,
    stage_runtime_id: Option<uuid::Uuid>,
    project_id: String,
    unit_path: String,
    actor_id: String,
    alarm_name: String,
) {
    let input = ActorRunInput {
        project_id: project_id.clone(),
        unit_path: unit_path.clone(),
        actor_id: actor_id.clone(),
        handler: alarm_name.clone(),
        payload_json: "{}".to_string(),
        kind: ActorKind::Alarm,
        alarm_name: Some(alarm_name.clone()),
        error_msg: None,
    };
    let comm_for_alarm = comm.with_stage_runtime(stage_runtime_id);
    let pool = comm.pool.clone();
    let redis_conn = comm.redis_conn.clone();
    let rid_owned = stage_runtime_id.map(|u| u.to_string());
    let inner_rt = if stage_runtime_id.is_some() {
        "stage"
    } else {
        "production"
    };
    let corr = TriggerCorrelation::empty();

    let release_id_owned = match uuid::Uuid::parse_str(&project_id) {
        Ok(pu) => load_live_release_id_scoped(&pool, &redis_conn, pu, stage_runtime_id)
            .await
            .ok()
            .flatten()
            .map(|u| u.to_string()),
        Err(_) => None,
    };
    let extras = AsyncConsumerSpanExtras {
        baal_unit_path: Some(unit_path.as_str()),
        baal_actor_instance_id: Some(actor_id.as_str()),
        baal_release_id: release_id_owned.as_deref(),
        ..Default::default()
    };
    let consumer_cx = async_consumer_context(
        &corr,
        "baal.consumer.actor.alarm",
        "internal_alarm",
        Some(project_id.as_str()),
        Some(inner_rt),
        rid_owned.as_deref(),
        Some(&extras),
    );
    let result = run_actor_with_lock(input, comm_for_alarm, None)
        .with_context(consumer_cx)
        .await;
    match result {
        Ok(_) => {
            cancel_alarm(
                &actor_redis,
                &project_id,
                stage_runtime_id,
                &unit_path,
                &actor_id,
                &alarm_name,
            )
            .await;
            tracing::info!(
                project_id = %project_id,
                unit_path = %unit_path,
                actor_id = %actor_id,
                alarm_name = %alarm_name,
                "[alarm_sweeper] alarm run ok"
            );
        }
        Err(e) => {
            restore_alarm_to_global(
                &actor_redis,
                &project_id,
                stage_runtime_id,
                &unit_path,
                &actor_id,
                &alarm_name,
            )
            .await;
            warn!(
                project_id = %project_id,
                unit_path = %unit_path,
                actor_id = %actor_id,
                alarm_name = %alarm_name,
                error = %e,
                "[alarm_sweeper] alarm run failed, re-queued"
            );
        }
    }
}

pub async fn run_alarm_sweeper(comm: Arc<SdkCommCtx>) {
    let dispatch_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_ALARM_RUNS));

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let actor_redis = match comm.actor_redis.clone() {
            Some(r) => r,
            None => continue,
        };

        let now_ms = chrono::Utc::now().timestamp_millis();
        let due = pop_due_alarms(&actor_redis, now_ms).await;

        if !due.is_empty() {
            tracing::info!(count = due.len(), "[alarm_sweeper] dispatching due alarms");
        }

        for (stage_runtime_id, project_id, unit_path, actor_id, alarm_name) in due {
            let actor_redis_task = actor_redis.clone();
            let comm_task = comm.clone();
            let dispatch_slots = dispatch_slots.clone();
            tokio::spawn(async move {
                let Ok(_permit) = dispatch_slots.acquire_owned().await else {
                    restore_alarm_to_global(
                        &actor_redis_task,
                        &project_id,
                        stage_runtime_id,
                        &unit_path,
                        &actor_id,
                        &alarm_name,
                    )
                    .await;
                    return;
                };
                dispatch_one_alarm(
                    actor_redis_task,
                    comm_task,
                    stage_runtime_id,
                    project_id,
                    unit_path,
                    actor_id,
                    alarm_name,
                )
                .await;
            });
        }
    }
}

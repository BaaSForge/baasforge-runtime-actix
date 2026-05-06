use crate::libs::unit_js::actor_runner::ActorKind;
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::services::actor_engine::pop_due_alarms;
use crate::services::actor_worker::manager::{ActorRunInput, run_actor_with_lock};
use crate::telemetry::{async_consumer_context, AsyncConsumerSpanExtras, TriggerCorrelation};
use opentelemetry::trace::FutureExt;
use std::sync::Arc;
use tracing::warn;

pub async fn run_alarm_sweeper(comm: Arc<SdkCommCtx>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let actor_redis = match comm.actor_redis.clone() {
            Some(r) => r,
            None => continue,
        };

        let now_ms = chrono::Utc::now().timestamp_millis();
        let due = pop_due_alarms(&actor_redis, now_ms).await;

        for (stage_runtime_id, project_id, unit_path, actor_id, alarm_name) in due {
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
            let rid_owned = stage_runtime_id.map(|u| u.to_string());
            let inner_rt = if stage_runtime_id.is_some() {
                "stage"
            } else {
                "production"
            };
            let corr = TriggerCorrelation::empty();
            let extras = AsyncConsumerSpanExtras {
                baal_unit_path: Some(unit_path.as_str()),
                baal_actor_instance_id: Some(actor_id.as_str()),
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

            if let Err(e) = (async move { run_actor_with_lock(input, comm_for_alarm).await })
                .with_context(consumer_cx)
                .await
            {
                warn!(
                    project_id = %project_id,
                    unit_path = %unit_path,
                    actor_id = %actor_id,
                    alarm_name = %alarm_name,
                    error = %e,
                    "[alarm_sweeper] alarm run failed"
                );
            }
        }
    }
}

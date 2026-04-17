use crate::database::DbPool;
use crate::libs::unit_js::actor_runner::ActorKind;
use crate::routes::ActorLocks;
use crate::services::actor_engine::{ActorRedis, pop_due_alarms};
use crate::services::actor_worker::manager::{ActorRunInput, run_actor_with_lock};
use tracing::warn;

pub async fn run_alarm_sweeper(
    actor_redis: ActorRedis,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    nats: Option<async_nats::Client>,
    locks: ActorLocks,
    base_url: String,
) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let now_ms = chrono::Utc::now().timestamp_millis();

        let due = pop_due_alarms(&actor_redis, now_ms).await;
        for (project_id, unit_path, actor_id, alarm_name) in due {
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

            if let Err(e) = run_actor_with_lock(
                input,
                &actor_redis,
                &pool,
                &redis_conn,
                &nats,
                &locks,
                &base_url,
            )
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

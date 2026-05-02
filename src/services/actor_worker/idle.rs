use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::services::actor_engine::ACTOR_IDLE_DUE_ZSET;
use crate::services::actor_worker::manager::passivate_actor;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

fn parse_idle_member(member: &str) -> Option<(String, Option<Uuid>, String, String)> {
    let p: Vec<&str> = member.split('\t').collect();
    match p.as_slice() {
        ["prod", pid, up, aid] => Some(((*pid).to_string(), None, (*up).to_string(), (*aid).to_string())),
        ["stage", rid, pid, up, aid] => {
            let r = Uuid::parse_str(rid).ok()?;
            Some(((*pid).to_string(), Some(r), (*up).to_string(), (*aid).to_string()))
        }
        _ => None,
    }
}

async fn sweep_once(comm: &Arc<SdkCommCtx>) {
    let Some(redis) = comm.actor_redis.as_ref() else {
        return;
    };
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let members: Vec<String> = {
        let mut c = redis.lock().await;
        redis::cmd("ZRANGEBYSCORE")
            .arg(ACTOR_IDLE_DUE_ZSET)
            .arg("-inf")
            .arg(now)
            .arg("LIMIT")
            .arg(0)
            .arg(64)
            .query_async(&mut *c)
            .await
            .unwrap_or_default()
    };
    for m in members {
        let Some((pid, stage, up, aid)) = parse_idle_member(&m) else {
            let mut c = redis.lock().await;
            let _: () = redis::cmd("ZREM")
                .arg(ACTOR_IDLE_DUE_ZSET)
                .arg(&m)
                .query_async(&mut *c)
                .await
                .unwrap_or(());
            continue;
        };
        passivate_actor(
            redis,
            comm.actor_pg.as_ref(),
            &comm.actor_nats,
            &pid,
            &up,
            &aid,
            stage,
            true,
            Some(&comm.actor_locks),
        )
        .await;
    }
}

pub async fn run_actor_idle_sweep(comm: Arc<SdkCommCtx>, interval: Duration) {
    if comm.actor_redis.is_none() {
        return;
    }
    loop {
        tokio::time::sleep(interval).await;
        sweep_once(&comm).await;
    }
}

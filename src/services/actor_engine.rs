use async_nats::jetstream::{self, stream};
use redis::AsyncCommands;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

pub type ActorRedis = Arc<Mutex<redis::aio::MultiplexedConnection>>;

pub const ACTOR_NATS_STREAM: &str = "ACTOR_MAIL";
pub const ACTOR_NATS_STREAM_SUBJECTS: &[&str] = &["actor.*.*.*.*.msg"];
pub const ACTOR_NATS_CONSUMER: &str = "actor_mail_consumer";

fn actor_key(project_id: &str, unit_path: &str, actor_id: &str, suffix: &str) -> String {
    format!("actor:{project_id}:{unit_path}:{actor_id}:{suffix}")
}

fn global_alarm_key() -> String {
    "actor:alarms:global".to_string()
}

fn encode_nats_component(s: &str) -> String {
    s.replace('.', "~")
}

pub async fn ensure_actor_mail_stream(
    client: &async_nats::Client,
    stream_name: &str,
) -> Result<jetstream::stream::Stream, String> {
    let js = jetstream::new(client.clone());
    let subjects = ACTOR_NATS_STREAM_SUBJECTS
        .iter()
        .map(|s| s.to_string())
        .collect();
    js.create_or_update_stream(stream::Config {
        name: stream_name.to_string(),
        subjects,
        ..Default::default()
    })
    .await
    .map_err(|e| format!("actor JetStream stream setup failed: {e}"))?;
    js.get_stream(stream_name)
        .await
        .map_err(|e| format!("actor JetStream get_stream failed: {e}"))
}

pub async fn publish_actor_message(
    js: &jetstream::Context,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    handler: &str,
    payload_json: &str,
    reply_to: Option<&str>,
    stage_runtime_id: Option<&str>,
) -> Result<String, String> {
    let encoded_unit_path = encode_nats_component(unit_path);
    let subject = format!("actor.{project_id}.{encoded_unit_path}.{actor_id}.{handler}.msg");
    let msg_id = crate::libs::ids::new_uuid().to_string();
    let mut msg_payload = serde_json::json!({
        "msgId": msg_id,
        "projectId": project_id,
        "unitPath": unit_path,
        "actorId": actor_id,
        "handler": handler,
        "payload": payload_json,
        "replyTo": reply_to,
    });
    if let Some(s) = stage_runtime_id {
        msg_payload["stageRuntimeId"] = serde_json::json!(s);
    }
    js.publish(subject, bytes::Bytes::from(msg_payload.to_string()))
        .await
        .map_err(|e| format!("actor mailbox publish failed: {e}"))?;
    Ok(msg_id)
}

pub async fn publish_actor_event(
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    event_type: &str,
) {
    let Some(nc) = nats else { return };
    let encoded_unit_path = encode_nats_component(unit_path);
    let subject = format!("actor.events.{project_id}.{encoded_unit_path}.{actor_id}");
    let payload = serde_json::json!({
        "type": event_type,
        "project_id": project_id,
        "unit_path": unit_path,
        "actor_id": actor_id,
        "at": chrono::Utc::now().timestamp_millis(),
    });
    if let Err(e) = nc
        .publish(subject, bytes::Bytes::from(payload.to_string()))
        .await
    {
        tracing::warn!(error = %e, "publish_actor_event failed");
    }
}

pub async fn load_hot_state(
    redis: &ActorRedis,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> Option<(Value, i64)> {
    let state_key = actor_key(project_id, unit_path, actor_id, "state");
    let version_key = actor_key(project_id, unit_path, actor_id, "version");
    let mut conn = redis.lock().await;
    let state_raw: Option<String> = conn.get(&state_key).await.unwrap_or(None);
    let version: Option<i64> = conn.get(&version_key).await.unwrap_or(None);
    if let (Some(s), Some(v)) = (state_raw, version) {
        let val = serde_json::from_str(&s).ok()?;
        Some((val, v))
    } else {
        None
    }
}

const COMMIT_STATE_LUA: &str = r#"
local state_key = KEYS[1]
local version_key = KEYS[2]
local new_state = ARGV[1]
local new_version = tonumber(ARGV[2])
redis.call('SET', state_key, new_state)
redis.call('SET', version_key, tostring(new_version))
return new_version
"#;

pub async fn commit_state(
    redis: &ActorRedis,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    new_state: &Value,
    new_version: i64,
) -> Result<i64, String> {
    let state_key = actor_key(project_id, unit_path, actor_id, "state");
    let version_key = actor_key(project_id, unit_path, actor_id, "version");
    let state_json = serde_json::to_string(new_state).map_err(|e| e.to_string())?;
    let mut conn = redis.lock().await;
    let result: i64 = redis::Script::new(COMMIT_STATE_LUA)
        .key(&state_key)
        .key(&version_key)
        .arg(&state_json)
        .arg(new_version)
        .invoke_async(&mut *conn)
        .await
        .map_err(|e| format!("commit_state lua error: {e}"))?;
    Ok(result)
}

pub async fn delete_actor_state(
    redis: &ActorRedis,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) {
    let keys: Vec<String> = ["state", "version", "lease", "last_access"]
        .iter()
        .map(|s| actor_key(project_id, unit_path, actor_id, s))
        .collect();
    let alarms_key = actor_key(project_id, unit_path, actor_id, "alarms");
    let mut conn = redis.lock().await;
    for key in &keys {
        let _: () = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut *conn)
            .await
            .unwrap_or(());
    }
    let _: () = redis::cmd("DEL")
        .arg(&alarms_key)
        .query_async(&mut *conn)
        .await
        .unwrap_or(());

    let alarm_global = global_alarm_key();
    let members: Vec<String> = redis::cmd("ZRANGEBYSCORE")
        .arg(&alarm_global)
        .arg("-inf")
        .arg("+inf")
        .query_async(&mut *conn)
        .await
        .unwrap_or_default();
    let prefix = format!("{project_id}|{unit_path}|{actor_id}|");
    for member in members.iter().filter(|m| m.starts_with(&prefix)) {
        let _: () = redis::cmd("ZREM")
            .arg(&alarm_global)
            .arg(member)
            .query_async(&mut *conn)
            .await
            .unwrap_or(());
    }
}

pub async fn set_alarm(
    redis: &ActorRedis,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
    fire_at_ms: i64,
) {
    let alarms_key = actor_key(project_id, unit_path, actor_id, "alarms");
    let global_key = global_alarm_key();
    let global_member = format!("{project_id}|{unit_path}|{actor_id}|{alarm_name}");
    let score = fire_at_ms as f64;
    let mut conn = redis.lock().await;
    let _: () = redis::cmd("ZADD")
        .arg(&alarms_key)
        .arg(score)
        .arg(alarm_name)
        .query_async(&mut *conn)
        .await
        .unwrap_or(());
    let _: () = redis::cmd("ZADD")
        .arg(&global_key)
        .arg(score)
        .arg(&global_member)
        .query_async(&mut *conn)
        .await
        .unwrap_or(());
}

pub async fn cancel_alarm(
    redis: &ActorRedis,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
) {
    let alarms_key = actor_key(project_id, unit_path, actor_id, "alarms");
    let global_key = global_alarm_key();
    let global_member = format!("{project_id}|{unit_path}|{actor_id}|{alarm_name}");
    let mut conn = redis.lock().await;
    let _: () = redis::cmd("ZREM")
        .arg(&alarms_key)
        .arg(alarm_name)
        .query_async(&mut *conn)
        .await
        .unwrap_or(());
    let _: () = redis::cmd("ZREM")
        .arg(&global_key)
        .arg(&global_member)
        .query_async(&mut *conn)
        .await
        .unwrap_or(());
}

pub async fn pop_due_alarms(
    redis: &ActorRedis,
    now_ms: i64,
) -> Vec<(String, String, String, String)> {
    let global_key = global_alarm_key();
    let score = now_ms as f64;
    let mut conn = redis.lock().await;
    let members: Vec<String> = redis::cmd("ZRANGEBYSCORE")
        .arg(&global_key)
        .arg("-inf")
        .arg(score)
        .query_async(&mut *conn)
        .await
        .unwrap_or_default();
    let mut result = Vec::new();
    for member in &members {
        let parts: Vec<&str> = member.splitn(4, '|').collect();
        if parts.len() == 4 {
            result.push((
                parts[0].to_string(),
                parts[1].to_string(),
                parts[2].to_string(),
                parts[3].to_string(),
            ));
            let _: () = redis::cmd("ZREM")
                .arg(&global_key)
                .arg(member)
                .query_async(&mut *conn)
                .await
                .unwrap_or(());
        }
    }
    result
}

pub async fn get_actor_state_and_version(
    redis: &ActorRedis,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> Option<(Value, i64)> {
    load_hot_state(redis, project_id, unit_path, actor_id).await
}

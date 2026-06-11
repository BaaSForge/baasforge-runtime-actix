use async_nats::jetstream::{self, stream};
use redis::AsyncCommands;
use serde_json::Value;
use uuid::Uuid;

pub type ActorRedis = crate::database::RedisConn;

pub const ACTOR_NATS_STREAM: &str = "ACTOR_MAIL";
pub const ACTOR_NATS_STREAM_SUBJECTS: &[&str] = &["actor.*.*.*.*.msg"];
pub const ACTOR_NATS_CONSUMER: &str = "actor_mail_consumer";
pub const ACTOR_IDLE_DUE_ZSET: &str = "actor:idle:due";

fn actor_key(
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    suffix: &str,
) -> String {
    let ns = match stage_runtime_id {
        None => format!("p:{project_id}"),
        Some(rid) => format!("s:{rid}"),
    };
    format!("actor:{ns}:{unit_path}:{actor_id}:{suffix}")
}

fn global_alarm_key() -> String {
    "actor:alarms:global".to_string()
}

fn alarm_global_member(
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
) -> String {
    match stage_runtime_id {
        None => format!("prod\t{project_id}\t{unit_path}\t{actor_id}\t{alarm_name}"),
        Some(rid) => format!("stage\t{rid}\t{project_id}\t{unit_path}\t{actor_id}\t{alarm_name}"),
    }
}

fn parse_alarm_global_member(
    member: &str,
) -> Option<(Option<Uuid>, String, String, String, String)> {
    let parts_tab: Vec<&str> = member.split('\t').collect();
    match parts_tab.as_slice() {
        [scope, project_id, unit_path, actor_id, alarm_name] if *scope == "prod" => Some((
            None,
            (*project_id).to_string(),
            (*unit_path).to_string(),
            (*actor_id).to_string(),
            (*alarm_name).to_string(),
        )),
        [scope, rid, project_id, unit_path, actor_id, alarm_name] if *scope == "stage" => {
            Uuid::parse_str(rid).ok().map(|r| {
                (
                    Some(r),
                    (*project_id).to_string(),
                    (*unit_path).to_string(),
                    (*actor_id).to_string(),
                    (*alarm_name).to_string(),
                )
            })
        }
        _ => {
            let parts: Vec<&str> = member.splitn(4, '|').collect();
            (parts.len() == 4).then(|| {
                (
                    None,
                    parts[0].to_string(),
                    parts[1].to_string(),
                    parts[2].to_string(),
                    parts[3].to_string(),
                )
            })
        }
    }
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
    crate::rt_enter!(
        "actor.nats.publish",
        project_id,
        unit_path,
        actor_id,
        handler,
        stage_runtime_id = stage_runtime_id.unwrap_or(""),
        reply_to = reply_to.unwrap_or("")
    );
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
    if let Some(obj) = msg_payload.as_object_mut() {
        crate::telemetry::inject_traceparent_json_field(obj);
    }
    crate::rt_step!("actor.nats.publish.jetstream", subject = %subject, msg_id = %msg_id);
    crate::nats::publish_jetstream(js, subject.clone(), bytes::Bytes::from(msg_payload.to_string()))
        .await
        .map_err(|e| e.to_string())?;
    crate::rt_exit_ok!("actor.nats.publish", subject = %subject, msg_id = %msg_id);
    Ok(msg_id)
}

pub async fn publish_actor_event(
    nats: &Option<async_nats::Client>,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    event_type: &str,
    stage_runtime_id: Option<Uuid>,
) {
    let Some(nc) = nats else { return };
    let encoded_unit_path = encode_nats_component(unit_path);
    let subject = format!("actor.events.{project_id}.{encoded_unit_path}.{actor_id}");
    let mut payload = serde_json::json!({
        "type": event_type,
        "project_id": project_id,
        "unit_path": unit_path,
        "actor_id": actor_id,
        "at": chrono::Utc::now().timestamp_millis(),
    });
    if let Some(rid) = stage_runtime_id {
        if let serde_json::Value::Object(ref mut obj) = payload {
            obj.insert("stageRuntimeId".to_string(), serde_json::json!(rid.to_string()));
        }
    }
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
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) -> Option<(Value, i64)> {
    let state_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "state");
    let version_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "version");
    let mut conn = redis.clone();
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
local last_access_key = KEYS[3]
local new_state = ARGV[1]
local new_version = tonumber(ARGV[2])
local last_access = ARGV[3]
redis.call('SET', state_key, new_state)
redis.call('SET', version_key, tostring(new_version))
redis.call('SET', last_access_key, last_access)
return new_version
"#;

pub fn idle_due_member(
    stage_runtime_id: Option<Uuid>,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> String {
    match stage_runtime_id {
        None => format!("prod\t{project_id}\t{unit_path}\t{actor_id}"),
        Some(rid) => format!("stage\t{rid}\t{project_id}\t{unit_path}\t{actor_id}"),
    }
}

pub async fn refresh_actor_idle_deadline(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    max_idle_ms: u64,
) {
    let last_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "last_access");
    let mut conn = redis.clone();
    let last_raw: Option<String> = conn.get(&last_key).await.unwrap_or(None);
    let Some(last_s) = last_raw else {
        return;
    };
    let Ok(ts) = last_s.parse::<i64>() else {
        return;
    };
    let deadline = ts as f64 + max_idle_ms as f64;
    let member = idle_due_member(stage_runtime_id, project_id, unit_path, actor_id);
    let _: () = redis::cmd("ZADD")
        .arg(ACTOR_IDLE_DUE_ZSET)
        .arg(deadline)
        .arg(&member)
        .query_async(&mut conn)
        .await
        .unwrap_or(());
}

pub async fn clear_actor_idle_deadline(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) {
    let member = idle_due_member(stage_runtime_id, project_id, unit_path, actor_id);
    let mut conn = redis.clone();
    let _: () = redis::cmd("ZREM")
        .arg(ACTOR_IDLE_DUE_ZSET)
        .arg(&member)
        .query_async(&mut conn)
        .await
        .unwrap_or(());
}

pub async fn bump_actor_last_access_if_present(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) -> bool {
    let state_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "state");
    let last_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "last_access");
    let mut conn = redis.clone();
    let exists: bool = conn.exists(&state_key).await.unwrap_or(false);
    if !exists {
        return false;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let _: () = redis::cmd("SET")
        .arg(&last_key)
        .arg(now)
        .query_async(&mut conn)
        .await
        .unwrap_or(());
    true
}

pub async fn commit_state(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    new_state: &Value,
    new_version: i64,
) -> Result<i64, String> {
    let state_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "state");
    let version_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "version");
    let last_access_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "last_access");
    let state_json = serde_json::to_string(new_state).map_err(|e| e.to_string())?;
    let now_ms = chrono::Utc::now().timestamp_millis().to_string();
    let mut conn = redis.clone();
    let result: i64 = redis::Script::new(COMMIT_STATE_LUA)
        .key(&state_key)
        .key(&version_key)
        .key(&last_access_key)
        .arg(&state_json)
        .arg(new_version)
        .arg(&now_ms)
        .invoke_async(&mut conn)
        .await
        .map_err(|e| format!("commit_state lua error: {e}"))?;
    Ok(result)
}

pub async fn evict_actor_hot_cache_keep_alarms(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) {
    let keys: Vec<String> = ["state", "version", "lease", "last_access"]
        .iter()
        .map(|s| actor_key(project_id, stage_runtime_id, unit_path, actor_id, s))
        .collect();
    let mut conn = redis.clone();
    for key in &keys {
        let _: () = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .unwrap_or(());
    }
}

pub async fn delete_actor_state(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) {
    let keys: Vec<String> = ["state", "version", "lease", "last_access"]
        .iter()
        .map(|s| actor_key(project_id, stage_runtime_id, unit_path, actor_id, s))
        .collect();
    let alarms_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "alarms");
    let mut conn = redis.clone();
    for key in &keys {
        let _: () = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .unwrap_or(());
    }
    let _: () = redis::cmd("DEL")
        .arg(&alarms_key)
        .query_async(&mut conn)
        .await
        .unwrap_or(());

    let alarm_global = global_alarm_key();
    let members: Vec<String> = redis::cmd("ZRANGEBYSCORE")
        .arg(&alarm_global)
        .arg("-inf")
        .arg("+inf")
        .query_async(&mut conn)
        .await
        .unwrap_or_default();
    let prefix_prod = format!("prod\t{project_id}\t{unit_path}\t{actor_id}\t");
    let prefix_stage = stage_runtime_id
        .map(|rid| format!("stage\t{rid}\t{project_id}\t{unit_path}\t{actor_id}\t"));
    for member in members.iter() {
        let remove = member.starts_with(&prefix_prod)
            || prefix_stage
                .as_ref()
                .is_some_and(|p| member.starts_with(p));
        if remove {
            let _: () = redis::cmd("ZREM")
                .arg(&alarm_global)
                .arg(member)
                .query_async(&mut conn)
                .await
                .unwrap_or(());
        }
    }
}

pub async fn set_alarm(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
    fire_at_ms: i64,
) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let fire_at_ms = fire_at_ms.max(now_ms);
    let alarms_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "alarms");
    let global_key = global_alarm_key();
    let global_member = alarm_global_member(project_id, stage_runtime_id, unit_path, actor_id, alarm_name);
    let score = fire_at_ms as f64;
    let mut conn = redis.clone();
    let r1: redis::RedisResult<()> = redis::cmd("ZADD")
        .arg(&alarms_key)
        .arg(score)
        .arg(alarm_name)
        .query_async(&mut conn)
        .await;
    if let Err(ref e) = r1 {
        tracing::warn!(error = %e, "[set_alarm] ZADD actor alarms_key failed");
    }
    let r2: redis::RedisResult<()> = redis::cmd("ZADD")
        .arg(&global_key)
        .arg(score)
        .arg(&global_member)
        .query_async(&mut conn)
        .await;
    if let Err(ref e) = r2 {
        tracing::warn!(error = %e, "[set_alarm] ZADD global_key failed");
    }
    tracing::info!(
        unit_path = %unit_path,
        actor_id = %actor_id,
        alarm_name = %alarm_name,
        fire_at_ms = fire_at_ms,
        global_member = %global_member,
        "[set_alarm] alarm registered"
    );
}

pub async fn cancel_alarm(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
) {
    let alarms_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "alarms");
    let global_key = global_alarm_key();
    let global_member = alarm_global_member(project_id, stage_runtime_id, unit_path, actor_id, alarm_name);
    let mut conn = redis.clone();
    let _: () = redis::cmd("ZREM")
        .arg(&alarms_key)
        .arg(alarm_name)
        .query_async(&mut conn)
        .await
        .unwrap_or(());
    let _: () = redis::cmd("ZREM")
        .arg(&global_key)
        .arg(&global_member)
        .query_async(&mut conn)
        .await
        .unwrap_or(());
}

const POP_DUE_ALARMS_LUA: &str = r#"
local key = KEYS[1]
local score = ARGV[1]
local limit = tonumber(ARGV[2])
local members = redis.call('ZRANGEBYSCORE', key, '-inf', score, 'LIMIT', 0, limit)
if #members > 0 then
    for i = 1, #members do
        redis.call('ZREM', key, members[i])
    end
end
return members
"#;

const MAX_ALARMS_POPPED_PER_SWEEP: isize = 32;

pub async fn pop_due_alarms(
    redis: &ActorRedis,
    now_ms: i64,
) -> Vec<(Option<Uuid>, String, String, String, String)> {
    let global_key = global_alarm_key();
    let score = now_ms as f64;
    let members: Vec<String> = {
        let mut conn = redis.clone();
        let result: redis::RedisResult<Vec<String>> = redis::Script::new(POP_DUE_ALARMS_LUA)
            .key(&global_key)
            .arg(score)
            .arg(MAX_ALARMS_POPPED_PER_SWEEP)
            .invoke_async(&mut conn)
            .await;
        match result {
            Err(ref e) => {
                tracing::warn!(error = %e, "[pop_due_alarms] Lua script failed");
                vec![]
            }
            Ok(v) => v,
        }
    };
    members
        .iter()
        .filter_map(|member| parse_alarm_global_member(member))
        .collect()
}

pub async fn restore_alarm_to_global(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
) {
    let alarms_key = actor_key(project_id, stage_runtime_id, unit_path, actor_id, "alarms");
    let global_key = global_alarm_key();
    let global_member = alarm_global_member(project_id, stage_runtime_id, unit_path, actor_id, alarm_name);
    let mut conn = redis.clone();
    let score: Option<f64> = redis::cmd("ZSCORE")
        .arg(&alarms_key)
        .arg(alarm_name)
        .query_async(&mut conn)
        .await
        .ok()
        .flatten();
    let Some(score) = score else {
        return;
    };
    let _: redis::RedisResult<()> = redis::cmd("ZADD")
        .arg(&global_key)
        .arg(score)
        .arg(&global_member)
        .query_async(&mut conn)
        .await;
}

pub async fn get_actor_state_and_version(
    redis: &ActorRedis,
    project_id: &str,
    stage_runtime_id: Option<Uuid>,
    unit_path: &str,
    actor_id: &str,
) -> Option<(Value, i64)> {
    load_hot_state(redis, project_id, stage_runtime_id, unit_path, actor_id).await
}

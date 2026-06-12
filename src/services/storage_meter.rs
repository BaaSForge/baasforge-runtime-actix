use crate::database::RedisConn;
use crate::services::usage_meter::{log_storage_delta, StorageDeltaOp, StorageDeltaRecord};
use redis::AsyncCommands;

pub const STORE_NATS_WF: &str = "nats_wf";
pub const STORE_NATS_WQ: &str = "nats_wq";
pub const STORE_NATS_ACTOR: &str = "nats_actor";
pub const STORE_WF_REDIS: &str = "wf_redis";
pub const STORE_WQ_REDIS: &str = "wq_redis";
pub const STORE_ACTOR_REDIS: &str = "actor_redis";
pub const STORE_RUNTIME_ENV_REDIS: &str = "runtime_env_redis";
pub const STORE_ACTOR_PG: &str = "actor_pg";

pub const TIER_ACTIVE: &str = "active";
pub const TIER_RETAINED: &str = "retained";

const REDIS_ENTRY_OVERHEAD: u64 = 64;
const REDIS_LIST_ELEM_OVERHEAD: u64 = 48;

pub fn redis_stored_bytes(key: &str, value_byte_len: u64) -> u64 {
    key.len() as u64 + value_byte_len + REDIS_ENTRY_OVERHEAD
}

pub fn redis_entry_bytes(key: &str, value: &str) -> u64 {
    redis_stored_bytes(key, value.len() as u64)
}

pub fn redis_list_stored_bytes(key: &str, elements: &[impl AsRef<str>]) -> u64 {
    if elements.is_empty() {
        return 0;
    }
    let values: u64 = elements
        .iter()
        .map(|e| e.as_ref().len() as u64 + REDIS_LIST_ELEM_OVERHEAD)
        .sum();
    key.len() as u64 + values + REDIS_ENTRY_OVERHEAD
}

pub fn redis_list_rpush_delta_bytes(key: &str, item: &str, list_len_after: i64) -> u64 {
    let elem = item.len() as u64 + REDIS_LIST_ELEM_OVERHEAD;
    if list_len_after <= 1 {
        redis_stored_bytes(key, item.len() as u64) + REDIS_LIST_ELEM_OVERHEAD
    } else {
        elem
    }
}

pub fn nats_message_bytes(subject: &str, payload: &[u8]) -> u64 {
    subject.len() as u64 + payload.len() as u64
}

pub fn actor_pg_row_bytes(project_id: &str, unit_path: &str, actor_id: &str, state_json: &str) -> u64 {
    project_id.len() as u64
        + unit_path.len() as u64
        + actor_id.len() as u64
        + state_json.len() as u64
        + 128
}

pub fn wf_meta_tier(status: &str) -> &'static str {
    match status {
        "completed" | "failed" | "cancelled" => TIER_RETAINED,
        _ => TIER_ACTIVE,
    }
}

pub fn wq_meta_tier(status: &str) -> &'static str {
    match status {
        "completed" | "dead_letter" | "cancelled" => TIER_RETAINED,
        _ => TIER_ACTIVE,
    }
}

fn wf_billing_index_key(project_id: &str, instance_id: &str) -> String {
    format!("wf:{project_id}:{instance_id}:_billing")
}

fn wf_instance_id_from_key(redis_key: &str, project_id: &str) -> Option<String> {
    let prefix = format!("wf:{project_id}:");
    let rest = redis_key.strip_prefix(&prefix)?;
    let segment = rest.split(':').next()?;
    if segment == "name" {
        return None;
    }
    Some(segment.to_string())
}

fn wf_billing_ephemeral_key(redis_key: &str) -> bool {
    redis_key.ends_with(":exec_lock")
}

async fn wf_billing_hset(
    conn: &mut RedisConn,
    project_id: &str,
    instance_id: &str,
    redis_key: &str,
    bytes: u64,
) {
    if bytes == 0 {
        return;
    }
    let index_key = wf_billing_index_key(project_id, instance_id);
    let _: () = conn
        .hset(&index_key, redis_key, bytes.to_string())
        .await
        .unwrap_or(());
}

async fn wf_billing_hdel(
    conn: &mut RedisConn,
    project_id: &str,
    instance_id: &str,
    redis_key: &str,
) {
    let index_key = wf_billing_index_key(project_id, instance_id);
    let _: () = conn.hdel(&index_key, redis_key).await.unwrap_or(());
    let remaining: i64 = conn.hlen(&index_key).await.unwrap_or(0);
    if remaining == 0 {
        let _: () = conn.del(&index_key).await.unwrap_or(());
    }
}

async fn wf_billing_hget(
    conn: &mut RedisConn,
    project_id: &str,
    instance_id: &str,
    redis_key: &str,
) -> Option<u64> {
    let index_key = wf_billing_index_key(project_id, instance_id);
    let raw: Option<String> = conn.hget(&index_key, redis_key).await.ok().flatten();
    raw.and_then(|s| s.parse().ok())
}

pub async fn wf_billing_track_key(
    conn: &mut RedisConn,
    project_id: &str,
    instance_id: &str,
    redis_key: &str,
    value: &str,
) {
    wf_billing_hset(
        conn,
        project_id,
        instance_id,
        redis_key,
        redis_entry_bytes(redis_key, value),
    )
    .await;
}

async fn wf_billing_sync_active_key(
    conn: &mut RedisConn,
    project_id: &str,
    instance_id: &str,
    redis_key: &str,
    value: &str,
) {
    if wf_billing_ephemeral_key(redis_key) {
        return;
    }
    wf_billing_hset(
        conn,
        project_id,
        instance_id,
        redis_key,
        redis_entry_bytes(redis_key, value),
    )
    .await;
}

fn log_wf_tier_reclassify(project_id: &str, redis_key: &str, bytes: u64) {
    if bytes == 0 {
        return;
    }
    log_storage_delta(StorageDeltaRecord {
        project_id: project_id.to_string(),
        store: STORE_WF_REDIS,
        tier: TIER_ACTIVE,
        op: StorageDeltaOp::Decr,
        bytes,
        resource_key: redis_key.to_string(),
    });
    log_storage_delta(StorageDeltaRecord {
        project_id: project_id.to_string(),
        store: STORE_WF_REDIS,
        tier: TIER_RETAINED,
        op: StorageDeltaOp::Incr,
        bytes,
        resource_key: redis_key.to_string(),
    });
}

pub async fn meter_wq_redis_set_for_status(
    conn: &mut RedisConn,
    project_id: &str,
    key: &str,
    value: &str,
    status: &str,
) {
    meter_redis_set(conn, project_id, STORE_WQ_REDIS, wq_meta_tier(status), key, value).await;
}

pub async fn meter_wq_run_active_to_retained(
    conn: &mut RedisConn,
    project_id: &str,
    run_id: &str,
) {
    for suffix in ["meta", "result"] {
        let key = format!("wq:{project_id}:{run_id}:{suffix}");
        let bytes = redis_key_usage_bytes(conn, &key).await;
        if bytes == 0 {
            continue;
        }
        log_storage_delta(StorageDeltaRecord {
            project_id: project_id.to_string(),
            store: STORE_WQ_REDIS,
            tier: TIER_ACTIVE,
            op: StorageDeltaOp::Decr,
            bytes,
            resource_key: key.clone(),
        });
        log_storage_delta(StorageDeltaRecord {
            project_id: project_id.to_string(),
            store: STORE_WQ_REDIS,
            tier: TIER_RETAINED,
            op: StorageDeltaOp::Incr,
            bytes,
            resource_key: key,
        });
    }
}

pub async fn redis_key_usage_bytes(conn: &mut RedisConn, key: &str) -> u64 {
    let value_len = conn.strlen(key).await.unwrap_or(0);
    if value_len == 0 {
        return 0;
    }
    redis_stored_bytes(key, value_len as u64)
}

pub fn log_bytes_delta(
    project_id: &str,
    store: &'static str,
    tier: &'static str,
    resource_key: &str,
    old_bytes: u64,
    new_bytes: u64,
) {
    if new_bytes > old_bytes {
        log_storage_delta(StorageDeltaRecord {
            project_id: project_id.to_string(),
            store,
            tier,
            op: StorageDeltaOp::Incr,
            bytes: new_bytes - old_bytes,
            resource_key: resource_key.to_string(),
        });
    } else if old_bytes > new_bytes {
        log_storage_delta(StorageDeltaRecord {
            project_id: project_id.to_string(),
            store,
            tier,
            op: StorageDeltaOp::Decr,
            bytes: old_bytes - new_bytes,
            resource_key: resource_key.to_string(),
        });
    }
}

pub async fn meter_redis_set(
    conn: &mut RedisConn,
    project_id: &str,
    store: &'static str,
    tier: &'static str,
    key: &str,
    value: &str,
) {
    let old_bytes = if store == STORE_WF_REDIS && tier == TIER_ACTIVE {
        if let Some(instance_id) = wf_instance_id_from_key(key, project_id) {
            wf_billing_hget(conn, project_id, &instance_id, key)
                .await
                .unwrap_or(0)
        } else {
            redis_key_usage_bytes(conn, key).await
        }
    } else {
        redis_key_usage_bytes(conn, key).await
    };
    meter_redis_set_with_old(project_id, store, tier, key, old_bytes, value);
    if store == STORE_WF_REDIS && tier == TIER_ACTIVE {
        if let Some(instance_id) = wf_instance_id_from_key(key, project_id) {
            wf_billing_sync_active_key(conn, project_id, &instance_id, key, value).await;
        }
    }
}

pub fn meter_redis_set_with_old(
    project_id: &str,
    store: &'static str,
    tier: &'static str,
    key: &str,
    old_bytes: u64,
    value: &str,
) {
    log_bytes_delta(
        project_id,
        store,
        tier,
        key,
        old_bytes,
        redis_entry_bytes(key, value),
    );
}

pub async fn meter_wf_redis_set_with_old(
    conn: &mut RedisConn,
    project_id: &str,
    key: &str,
    old_bytes: u64,
    value: &str,
) {
    meter_redis_set_with_old(project_id, STORE_WF_REDIS, TIER_ACTIVE, key, old_bytes, value);
    if let Some(instance_id) = wf_instance_id_from_key(key, project_id) {
        wf_billing_sync_active_key(conn, project_id, &instance_id, key, value).await;
    }
}

pub fn meter_redis_decr_bytes(
    project_id: &str,
    store: &'static str,
    tier: &'static str,
    key: &str,
    bytes: u64,
) {
    if bytes == 0 {
        return;
    }
    log_storage_delta(StorageDeltaRecord {
        project_id: project_id.to_string(),
        store,
        tier,
        op: StorageDeltaOp::Decr,
        bytes,
        resource_key: key.to_string(),
    });
}

pub fn meter_redis_incr_bytes(
    project_id: &str,
    store: &'static str,
    tier: &'static str,
    key: &str,
    bytes: u64,
) {
    if bytes == 0 {
        return;
    }
    log_storage_delta(StorageDeltaRecord {
        project_id: project_id.to_string(),
        store,
        tier,
        op: StorageDeltaOp::Incr,
        bytes,
        resource_key: key.to_string(),
    });
}

pub async fn meter_redis_del(
    conn: &mut RedisConn,
    project_id: &str,
    store: &'static str,
    tier: &'static str,
    key: &str,
) {
    let old_bytes = if store == STORE_WF_REDIS && tier == TIER_ACTIVE {
        if let Some(instance_id) = wf_instance_id_from_key(key, project_id) {
            let indexed = wf_billing_hget(conn, project_id, &instance_id, key).await;
            wf_billing_hdel(conn, project_id, &instance_id, key).await;
            match indexed {
                Some(bytes) if bytes > 0 => bytes,
                _ => redis_key_usage_bytes(conn, key).await,
            }
        } else {
            redis_key_usage_bytes(conn, key).await
        }
    } else {
        redis_key_usage_bytes(conn, key).await
    };
    meter_redis_decr_bytes(project_id, store, tier, key, old_bytes);
}

pub fn meter_nats_incr(project_id: &str, store: &'static str, subject: &str, payload: &[u8]) {
    let bytes = nats_message_bytes(subject, payload);
    if bytes == 0 {
        return;
    }
    log_storage_delta(StorageDeltaRecord {
        project_id: project_id.to_string(),
        store,
        tier: TIER_RETAINED,
        op: StorageDeltaOp::Incr,
        bytes,
        resource_key: subject.to_string(),
    });
}

pub fn meter_nats_decr(project_id: &str, store: &'static str, subject: &str, payload: &[u8]) {
    let bytes = nats_message_bytes(subject, payload);
    if bytes == 0 {
        return;
    }
    log_storage_delta(StorageDeltaRecord {
        project_id: project_id.to_string(),
        store,
        tier: TIER_RETAINED,
        op: StorageDeltaOp::Decr,
        bytes,
        resource_key: subject.to_string(),
    });
}

pub async fn meter_wf_instance_active_to_retained(
    conn: &mut RedisConn,
    project_id: &str,
    instance_id: &str,
) {
    let index_key = wf_billing_index_key(project_id, instance_id);
    let entries: std::collections::HashMap<String, String> =
        conn.hgetall(&index_key).await.unwrap_or_default();
    for (key, bytes_raw) in entries {
        if wf_billing_ephemeral_key(&key) {
            continue;
        }
        let bytes = bytes_raw.parse::<u64>().unwrap_or(0);
        log_wf_tier_reclassify(project_id, &key, bytes);
    }
    let _: () = conn.del(&index_key).await.unwrap_or(());
}

pub fn meter_actor_pg_delta(
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    old_bytes: u64,
    new_bytes: u64,
) {
    let resource_key = format!("{project_id}/{unit_path}/{actor_id}");
    log_bytes_delta(
        project_id,
        STORE_ACTOR_PG,
        TIER_RETAINED,
        &resource_key,
        old_bytes,
        new_bytes,
    );
}

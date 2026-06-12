use crate::actor_schema::{actor_alarms, actor_snapshots};
use crate::services::storage_meter::{actor_pg_row_bytes, meter_actor_pg_delta, STORE_ACTOR_PG, TIER_RETAINED};
use crate::services::usage_meter::{log_storage_delta, StorageDeltaOp, StorageDeltaRecord};
use crate::database::{block_on_db_tokio, pg_pool_builder, BlockingDbError};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::upsert::excluded;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

pub type ActorPgPool = Arc<Pool<ConnectionManager<PgConnection>>>;

pub fn actor_snapshot_stage_key(stage_runtime_id: Option<Uuid>) -> Uuid {
    match stage_runtime_id {
        Some(id) => id,
        None => Uuid::parse_str("00000000-0000-0000-0000-000000000000").expect("actor snapshot prod stage key"),
    }
}

pub fn build_actor_pg_pool(
    database_url: &str,
    pool_size: u32,
    timeout_secs: u64,
    idle_timeout_secs: u64,
) -> ActorPgPool {
    let manager = ConnectionManager::<PgConnection>::new(database_url);
    let pool = pg_pool_builder(pool_size, timeout_secs, idle_timeout_secs)
        .build(manager)
        .expect("actor PG pool build failed");
    Arc::new(pool)
}

fn db_err(e: BlockingDbError) -> String {
    e.to_string()
}

#[derive(Insertable)]
#[diesel(table_name = actor_snapshots)]
struct NewSnapshot {
    project_id: Uuid,
    unit_path: String,
    actor_id: String,
    stage_runtime_id: Uuid,
    state: Value,
    version: i64,
    updated_at: DateTime<Utc>,
}

#[derive(Insertable)]
#[diesel(table_name = actor_alarms)]
struct NewAlarm {
    project_id: Uuid,
    unit_path: String,
    actor_id: String,
    alarm_name: String,
    fire_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

pub async fn upsert_snapshot(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    stage_runtime_id: Option<Uuid>,
    state: &Value,
    version: i64,
) -> Result<(), String> {
    let old_bytes = load_snapshot(pool, project_id, unit_path, actor_id, stage_runtime_id)
        .await
        .ok()
        .flatten()
        .map(|(old_state, _)| {
            let old_json = old_state.to_string();
            actor_pg_row_bytes(project_id, unit_path, actor_id, &old_json)
        })
        .unwrap_or(0);
    let new_json = state.to_string();
    let new_bytes = actor_pg_row_bytes(project_id, unit_path, actor_id, &new_json);

    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let stage_key = actor_snapshot_stage_key(stage_runtime_id);
    let state = state.clone();
    let now = Utc::now();
    let pid_str = project_id.to_string();
    let unit_path_log = unit_path.clone();
    let actor_id_log = actor_id.clone();
    block_on_db_tokio(pool.as_ref(), move |conn| {
        let row = NewSnapshot {
            project_id,
            unit_path,
            actor_id,
            stage_runtime_id: stage_key,
            state,
            version,
            updated_at: now,
        };
        diesel::insert_into(actor_snapshots::table)
            .values(&row)
            .on_conflict((
                actor_snapshots::project_id,
                actor_snapshots::unit_path,
                actor_snapshots::actor_id,
                actor_snapshots::stage_runtime_id,
            ))
            .do_update()
            .set((
                actor_snapshots::state.eq(excluded(actor_snapshots::state)),
                actor_snapshots::version.eq(excluded(actor_snapshots::version)),
                actor_snapshots::updated_at.eq(excluded(actor_snapshots::updated_at)),
            ))
            .execute(conn)?;
        Ok(())
    })
    .await
    .map_err(db_err)?;
    meter_actor_pg_delta(&pid_str, &unit_path_log, &actor_id_log, old_bytes, new_bytes);
    Ok(())
}

pub async fn load_snapshot(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    stage_runtime_id: Option<Uuid>,
) -> Result<Option<(Value, i64)>, String> {
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let stage_key = actor_snapshot_stage_key(stage_runtime_id);
    block_on_db_tokio(pool.as_ref(), move |conn| {
        actor_snapshots::table
            .filter(actor_snapshots::project_id.eq(project_id))
            .filter(actor_snapshots::unit_path.eq(&unit_path))
            .filter(actor_snapshots::actor_id.eq(&actor_id))
            .filter(actor_snapshots::stage_runtime_id.eq(stage_key))
            .select((actor_snapshots::state, actor_snapshots::version))
            .first::<(Value, i64)>(conn)
            .optional()
    })
    .await
    .map_err(db_err)
}

pub async fn delete_snapshot(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    stage_runtime_id: Option<Uuid>,
) -> Result<(), String> {
    let old_bytes = load_snapshot(pool, project_id, unit_path, actor_id, stage_runtime_id)
        .await
        .ok()
        .flatten()
        .map(|(old_state, _)| {
            let old_json = old_state.to_string();
            actor_pg_row_bytes(project_id, unit_path, actor_id, &old_json)
        })
        .unwrap_or(0);

    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let stage_key = actor_snapshot_stage_key(stage_runtime_id);
    let pid_str = project_id.to_string();
    let resource_key = format!("{pid_str}/{unit_path}/{actor_id}");
    block_on_db_tokio(pool.as_ref(), move |conn| {
        diesel::delete(
            actor_snapshots::table
                .filter(actor_snapshots::project_id.eq(project_id))
                .filter(actor_snapshots::unit_path.eq(&unit_path))
                .filter(actor_snapshots::actor_id.eq(&actor_id))
                .filter(actor_snapshots::stage_runtime_id.eq(stage_key)),
        )
        .execute(conn)?;
        Ok(())
    })
    .await
    .map_err(db_err)?;
    if old_bytes > 0 {
        log_storage_delta(StorageDeltaRecord {
            project_id: pid_str,
            store: STORE_ACTOR_PG,
            tier: TIER_RETAINED,
            op: StorageDeltaOp::Decr,
            bytes: old_bytes,
            resource_key,
        });
    }
    Ok(())
}

pub async fn upsert_alarm(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
    fire_at_ms: i64,
) -> Result<(), String> {
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let alarm_name = alarm_name.to_string();
    let fire_at = DateTime::from_timestamp_millis(fire_at_ms)
        .ok_or_else(|| "invalid fire_at_ms".to_string())?;
    let now = Utc::now();
    block_on_db_tokio(pool.as_ref(), move |conn| {
        let row = NewAlarm { project_id, unit_path, actor_id, alarm_name, fire_at, created_at: now };
        diesel::insert_into(actor_alarms::table)
            .values(&row)
            .on_conflict((
                actor_alarms::project_id,
                actor_alarms::unit_path,
                actor_alarms::actor_id,
                actor_alarms::alarm_name,
            ))
            .do_update()
            .set(actor_alarms::fire_at.eq(excluded(actor_alarms::fire_at)))
            .execute(conn)?;
        Ok(())
    })
    .await
    .map_err(db_err)
}

pub async fn delete_alarm(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
) -> Result<(), String> {
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let alarm_name = alarm_name.to_string();
    block_on_db_tokio(pool.as_ref(), move |conn| {
        diesel::delete(
            actor_alarms::table
                .filter(actor_alarms::project_id.eq(project_id))
                .filter(actor_alarms::unit_path.eq(&unit_path))
                .filter(actor_alarms::actor_id.eq(&actor_id))
                .filter(actor_alarms::alarm_name.eq(&alarm_name)),
        )
        .execute(conn)?;
        Ok(())
    })
    .await
    .map_err(db_err)
}

pub async fn delete_actor_alarms(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> Result<(), String> {
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    block_on_db_tokio(pool.as_ref(), move |conn| {
        diesel::delete(
            actor_alarms::table
                .filter(actor_alarms::project_id.eq(project_id))
                .filter(actor_alarms::unit_path.eq(&unit_path))
                .filter(actor_alarms::actor_id.eq(&actor_id)),
        )
        .execute(conn)?;
        Ok(())
    })
    .await
    .map_err(db_err)
}

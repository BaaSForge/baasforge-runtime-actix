use crate::actor_schema::{actor_alarms, actor_snapshots};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::upsert::excluded;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

pub type ActorPgPool = Arc<Pool<ConnectionManager<PgConnection>>>;

pub fn build_actor_pg_pool(database_url: &str, pool_size: u32, timeout_secs: u64) -> ActorPgPool {
    let manager = ConnectionManager::<PgConnection>::new(database_url);
    let pool = Pool::builder()
        .max_size(pool_size)
        .connection_timeout(Duration::from_secs(timeout_secs))
        .build(manager)
        .expect("actor PG pool build failed");
    Arc::new(pool)
}

#[derive(Insertable)]
#[diesel(table_name = actor_snapshots)]
struct NewSnapshot {
    project_id: Uuid,
    unit_path: String,
    actor_id: String,
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
    state: &Value,
    version: i64,
) -> Result<(), String> {
    let pool = pool.clone();
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let state = state.clone();
    let now = Utc::now();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get().map_err(|e| e.to_string())?;
        let row = NewSnapshot { project_id, unit_path, actor_id, state, version, updated_at: now };
        diesel::insert_into(actor_snapshots::table)
            .values(&row)
            .on_conflict((
                actor_snapshots::project_id,
                actor_snapshots::unit_path,
                actor_snapshots::actor_id,
            ))
            .do_update()
            .set((
                actor_snapshots::state.eq(excluded(actor_snapshots::state)),
                actor_snapshots::version.eq(excluded(actor_snapshots::version)),
                actor_snapshots::updated_at.eq(excluded(actor_snapshots::updated_at)),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn load_snapshot(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> Result<Option<(Value, i64)>, String> {
    let pool = pool.clone();
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get().map_err(|e| e.to_string())?;
        actor_snapshots::table
            .filter(actor_snapshots::project_id.eq(project_id))
            .filter(actor_snapshots::unit_path.eq(&unit_path))
            .filter(actor_snapshots::actor_id.eq(&actor_id))
            .select((actor_snapshots::state, actor_snapshots::version))
            .first::<(Value, i64)>(&mut conn)
            .optional()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_snapshot(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> Result<(), String> {
    let pool = pool.clone();
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get().map_err(|e| e.to_string())?;
        diesel::delete(
            actor_snapshots::table
                .filter(actor_snapshots::project_id.eq(project_id))
                .filter(actor_snapshots::unit_path.eq(&unit_path))
                .filter(actor_snapshots::actor_id.eq(&actor_id)),
        )
        .execute(&mut conn)
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn upsert_alarm(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
    fire_at_ms: i64,
) -> Result<(), String> {
    let pool = pool.clone();
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let alarm_name = alarm_name.to_string();
    let fire_at = DateTime::from_timestamp_millis(fire_at_ms)
        .ok_or_else(|| "invalid fire_at_ms".to_string())?;
    let now = Utc::now();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get().map_err(|e| e.to_string())?;
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
            .execute(&mut conn)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_alarm(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
    alarm_name: &str,
) -> Result<(), String> {
    let pool = pool.clone();
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    let alarm_name = alarm_name.to_string();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get().map_err(|e| e.to_string())?;
        diesel::delete(
            actor_alarms::table
                .filter(actor_alarms::project_id.eq(project_id))
                .filter(actor_alarms::unit_path.eq(&unit_path))
                .filter(actor_alarms::actor_id.eq(&actor_id))
                .filter(actor_alarms::alarm_name.eq(&alarm_name)),
        )
        .execute(&mut conn)
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_actor_alarms(
    pool: &ActorPgPool,
    project_id: &str,
    unit_path: &str,
    actor_id: &str,
) -> Result<(), String> {
    let pool = pool.clone();
    let project_id: Uuid = project_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let unit_path = unit_path.to_string();
    let actor_id = actor_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get().map_err(|e| e.to_string())?;
        diesel::delete(
            actor_alarms::table
                .filter(actor_alarms::project_id.eq(project_id))
                .filter(actor_alarms::unit_path.eq(&unit_path))
                .filter(actor_alarms::actor_id.eq(&actor_id)),
        )
        .execute(&mut conn)
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

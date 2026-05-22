//! Runtime environment variables: DB load, optional AES-256-GCM decrypt, Redis read-through cache.
//!
//! Uses the shared [`SharedRedisConn`] (`redis_conn` in [`SdkCommCtx`]) — same connection as release/unit cache.
//!
//! DB access is synchronous (`pool.get` + Diesel) so QuickJS host calls from `spawn_blocking` never nest
//! `block_on` + `block_on_db` (which could stall before the Redis `SET`).

use crate::database::{BlockingDbError, DbPool, SharedRedisConn};
use crate::models::runtime_env::{ProjectRuntimeEncryptionKeyRow, ProjectRuntimeEnvVarRow};
use crate::schema::{project_runtime_encryption_keys, project_runtime_env_vars};
use crate::services::project_runtime_cache::{redis_get_json, redis_set_json};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use diesel::prelude::*;
use redis::AsyncCommands;
use std::future::Future;
use thiserror::Error;
use uuid::Uuid;

const ENV_NONCE_LEN: usize = 12;
const ENV_KEY_LEN: usize = 32;

pub fn redis_key_env(project_id: Uuid, runtime_id: Uuid, key: &str) -> String {
    format!("shared:env:{project_id}:{runtime_id}:{key}")
}

#[derive(Debug, Error)]
pub enum RuntimeEnvError {
    #[error(transparent)]
    Db(#[from] BlockingDbError),
    #[error(transparent)]
    Redis(#[from] redis::RedisError),
    #[error("env var not found: {0}")]
    NotFound(String),
    #[error("invalid env key")]
    InvalidKey,
    #[error("encryption key missing for runtime")]
    EncryptionKeyMissing,
    #[error("decryption failed: {0}")]
    Decrypt(String),
}

/// Load a runtime env var (read-through Redis cache). Call from `spawn_blocking` / sync host fns only.
pub fn get_secure_env_blocking(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    runtime_id: Uuid,
    key: &str,
) -> Result<String, RuntimeEnvError> {
    let key = key.trim();
    crate::rt_enter!("runtime_env.get_secure_env", %project_id, %runtime_id, key);
    if key.is_empty() {
        crate::rt_exit_err!("runtime_env.get_secure_env", error = "invalid_key");
        return Err(RuntimeEnvError::InvalidKey);
    }

    let cache_key = redis_key_env(project_id, runtime_id, key);

    if redis.is_none() {
        tracing::warn!(
            %cache_key,
            "runtime env cache skipped (redis_conn unavailable; check REDIS_URL / startup logs)"
        );
    } else if let Some(cached) = block_on_redis(redis_get_json::<String>(redis, &cache_key))? {
        tracing::debug!(%cache_key, "runtime env cache hit");
        return Ok(cached);
    } else if redis.is_some() {
        tracing::debug!(%cache_key, "runtime env cache miss");
    }

    let row = load_env_var_row_sync(pool, project_id, runtime_id, key)?;
    let Some(row) = row else {
        return Err(RuntimeEnvError::NotFound(key.to_string()));
    };

    let plaintext = resolve_plaintext_sync(pool, &row)?;
    block_on_redis(redis_set_json(redis, &cache_key, &plaintext))?;
    if redis.is_some() {
        tracing::debug!(%cache_key, "runtime env cache set");
    }
    crate::rt_exit_ok!("runtime_env.get_secure_env", key);
    Ok(plaintext)
}

pub async fn get_secure_env(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    runtime_id: Uuid,
    key: &str,
) -> Result<String, RuntimeEnvError> {
    let pool = pool.clone();
    let redis = redis.clone();
    let key = key.trim().to_string();
    match tokio::task::spawn_blocking(move || {
        get_secure_env_blocking(&pool, &redis, project_id, runtime_id, &key)
    })
    .await
    {
        Ok(r) => r,
        Err(_) => Err(RuntimeEnvError::Db(BlockingDbError::Blocking)),
    }
}

pub async fn invalidate_env_cache(
    redis: &SharedRedisConn,
    project_id: Uuid,
    runtime_id: Uuid,
    key: &str,
) -> Result<(), redis::RedisError> {
    let Some(rc) = redis else {
        return Ok(());
    };
    let cache_key = redis_key_env(project_id, runtime_id, key.trim());
    let mut conn = rc.lock().await;
    let _: () = conn.del(&cache_key).await?;
    Ok(())
}

fn block_on_redis<T, F>(future: F) -> Result<T, RuntimeEnvError>
where
    F: Future<Output = Result<T, redis::RedisError>>,
{
    tokio::runtime::Handle::current()
        .block_on(future)
        .map_err(RuntimeEnvError::Redis)
}

fn load_env_var_row_sync(
    pool: &DbPool,
    project_id: Uuid,
    runtime_id: Uuid,
    key: &str,
) -> Result<Option<ProjectRuntimeEnvVarRow>, RuntimeEnvError> {
    let key_owned = key.to_string();
    let mut conn = pool.get().map_err(BlockingDbError::Pool)?;
    let row = project_runtime_env_vars::table
        .filter(project_runtime_env_vars::project_id.eq(project_id))
        .filter(project_runtime_env_vars::runtime_id.eq(runtime_id))
        .filter(project_runtime_env_vars::key.eq(key_owned))
        .select(ProjectRuntimeEnvVarRow::as_select())
        .first::<ProjectRuntimeEnvVarRow>(&mut conn)
        .optional()
        .map_err(BlockingDbError::Query)?;
    Ok(row)
}

fn load_encryption_key_sync(
    pool: &DbPool,
    runtime_id: Uuid,
) -> Result<Option<ProjectRuntimeEncryptionKeyRow>, RuntimeEnvError> {
    let mut conn = pool.get().map_err(BlockingDbError::Pool)?;
    let row = project_runtime_encryption_keys::table
        .filter(project_runtime_encryption_keys::runtime_id.eq(runtime_id))
        .select(ProjectRuntimeEncryptionKeyRow::as_select())
        .first::<ProjectRuntimeEncryptionKeyRow>(&mut conn)
        .optional()
        .map_err(BlockingDbError::Query)?;
    Ok(row)
}

fn resolve_plaintext_sync(
    pool: &DbPool,
    row: &ProjectRuntimeEnvVarRow,
) -> Result<String, RuntimeEnvError> {
    if !row.is_encrypted {
        return Ok(row.stored_value.clone());
    }
    let enc_key = load_encryption_key_sync(pool, row.runtime_id)?;
    let Some(enc_key) = enc_key else {
        return Err(RuntimeEnvError::EncryptionKeyMissing);
    };
    decrypt_stored_value(&enc_key.encryption_key, &row.stored_value)
}

fn decrypt_stored_value(key: &[u8], stored_value: &str) -> Result<String, RuntimeEnvError> {
    if key.len() != ENV_KEY_LEN {
        return Err(RuntimeEnvError::Decrypt(format!(
            "encryption key must be {ENV_KEY_LEN} bytes"
        )));
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(stored_value.trim())
        .map_err(|e| RuntimeEnvError::Decrypt(format!("invalid base64: {e}")))?;
    if data.len() <= ENV_NONCE_LEN {
        return Err(RuntimeEnvError::Decrypt("ciphertext too short".to_string()));
    }
    let (nonce_bytes, ciphertext) = data.split_at(ENV_NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| RuntimeEnvError::Decrypt(format!("invalid key: {e}")))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| RuntimeEnvError::Decrypt("aes-gcm decrypt failed".to_string()))?;
    String::from_utf8(plaintext)
        .map_err(|e| RuntimeEnvError::Decrypt(format!("utf-8: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_key_env_format() {
        let p = crate::libs::ids::new_uuid();
        let r = crate::libs::ids::new_uuid();
        assert_eq!(
            redis_key_env(p, r, "API_KEY"),
            format!("shared:env:{p}:{r}:API_KEY")
        );
    }

    #[test]
    fn decrypt_roundtrip() {
        use aes_gcm::aead::Aead;
        let key = [7u8; ENV_KEY_LEN];
        let nonce = [3u8; ENV_NONCE_LEN];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let pt = b"hello-secret";
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), pt.as_ref())
            .unwrap();
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ct);
        let stored = base64::engine::general_purpose::STANDARD.encode(&blob);
        let out = decrypt_stored_value(&key, &stored).unwrap();
        assert_eq!(out, "hello-secret");
    }
}

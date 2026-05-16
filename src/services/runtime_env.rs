//! Runtime environment variables: DB load, optional AES-256-GCM decrypt, Redis read-through cache.
//!
//! Uses the shared [`SharedRedisConn`] (`redis_conn` in [`SdkCommCtx`]) — same connection as release/unit cache.

use crate::database::{block_on_db, BlockingDbError, DbPool, SharedRedisConn};
use crate::models::runtime_env::{ProjectRuntimeEncryptionKeyRow, ProjectRuntimeEnvVarRow};
use crate::schema::{project_runtime_encryption_keys, project_runtime_env_vars};
use crate::services::project_runtime_cache::{redis_get_json, redis_set_json};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use diesel::prelude::*;
use redis::AsyncCommands;
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

pub async fn get_secure_env(
    pool: &DbPool,
    redis: &SharedRedisConn,
    project_id: Uuid,
    runtime_id: Uuid,
    key: &str,
) -> Result<String, RuntimeEnvError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(RuntimeEnvError::InvalidKey);
    }

    let cache_key = redis_key_env(project_id, runtime_id, key);

    if redis.is_none() {
        tracing::debug!(%cache_key, "runtime env cache skipped (redis_conn unavailable)");
    } else if let Some(cached) = redis_get_json::<String>(redis, &cache_key).await? {
        tracing::debug!(%cache_key, "runtime env cache hit");
        return Ok(cached);
    } else if redis.is_some() {
        tracing::debug!(%cache_key, "runtime env cache miss");
    }

    let row = load_env_var_row(pool, project_id, runtime_id, key).await?;
    let Some(row) = row else {
        return Err(RuntimeEnvError::NotFound(key.to_string()));
    };

    let plaintext = resolve_plaintext(pool, &row).await?;
    redis_set_json(redis, &cache_key, &plaintext).await?;
    if redis.is_some() {
        tracing::debug!(%cache_key, "runtime env cache set");
    }
    Ok(plaintext)
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

async fn resolve_plaintext(
    pool: &DbPool,
    row: &ProjectRuntimeEnvVarRow,
) -> Result<String, RuntimeEnvError> {
    if !row.is_encrypted {
        return Ok(row.stored_value.clone());
    }
    let enc_key = load_encryption_key(pool, row.runtime_id).await?;
    let Some(enc_key) = enc_key else {
        return Err(RuntimeEnvError::EncryptionKeyMissing);
    };
    decrypt_stored_value(&enc_key.encryption_key, &row.stored_value)
}

async fn load_env_var_row(
    pool: &DbPool,
    project_id: Uuid,
    runtime_id: Uuid,
    key: &str,
) -> Result<Option<ProjectRuntimeEnvVarRow>, RuntimeEnvError> {
    let key_owned = key.to_string();
    let row = block_on_db(pool, move |conn| {
        project_runtime_env_vars::table
            .filter(project_runtime_env_vars::project_id.eq(project_id))
            .filter(project_runtime_env_vars::runtime_id.eq(runtime_id))
            .filter(project_runtime_env_vars::key.eq(key_owned))
            .select(ProjectRuntimeEnvVarRow::as_select())
            .first::<ProjectRuntimeEnvVarRow>(conn)
            .optional()
    })
    .await?;
    Ok(row)
}

async fn load_encryption_key(
    pool: &DbPool,
    runtime_id: Uuid,
) -> Result<Option<ProjectRuntimeEncryptionKeyRow>, RuntimeEnvError> {
    let row = block_on_db(pool, move |conn| {
        project_runtime_encryption_keys::table
            .filter(project_runtime_encryption_keys::runtime_id.eq(runtime_id))
            .select(ProjectRuntimeEncryptionKeyRow::as_select())
            .first::<ProjectRuntimeEncryptionKeyRow>(conn)
            .optional()
    })
    .await?;
    Ok(row)
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

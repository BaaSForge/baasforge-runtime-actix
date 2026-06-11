use async_nats::connection::State;
use async_nats::jetstream;
use async_nats::{Client, ConnectError, ConnectOptions};
use bytes::Bytes;
use std::future::Future;
use std::time::Duration;

pub const NATS_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
pub const NATS_UNAVAILABLE_MSG: &str =
    "Runtime notification service is temporarily unavailable. Please retry shortly.";
const NATS_UNAVAILABLE_PREFIX: &str = "NATS_UNAVAILABLE:";

#[derive(Debug, Clone)]
pub enum NatsError {
    Unavailable(String),
    TimedOut,
    Publish(String),
}

impl NatsError {
    pub fn into_api_string(self) -> String {
        match self {
            Self::Unavailable(_) | Self::TimedOut => format!("{NATS_UNAVAILABLE_PREFIX}{NATS_UNAVAILABLE_MSG}"),
            Self::Publish(msg) => format!("{NATS_UNAVAILABLE_PREFIX}{msg}"),
        }
    }
}

impl std::fmt::Display for NatsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(msg) => write!(f, "{NATS_UNAVAILABLE_PREFIX}{msg}"),
            Self::TimedOut => write!(f, "{NATS_UNAVAILABLE_PREFIX}NATS operation timed out"),
            Self::Publish(msg) => write!(f, "{NATS_UNAVAILABLE_PREFIX}{msg}"),
        }
    }
}

pub fn is_nats_unavailable_error(error: &str) -> bool {
    error.starts_with(NATS_UNAVAILABLE_PREFIX)
        || error.contains(NATS_UNAVAILABLE_MSG)
}

pub fn nats_connect_options() -> ConnectOptions {
    ConnectOptions::new()
        .retry_on_initial_connect()
        .max_reconnects(None)
        .connection_timeout(Duration::from_secs(5))
        .reconnect_delay_callback(|attempts| {
            Duration::from_secs((1u64 << attempts.min(4)).min(30))
        })
}

fn apply_url_auth(mut options: ConnectOptions, url: &str) -> ConnectOptions {
    if let Ok(parsed) = url::Url::parse(url) {
        let user = parsed.username();
        let pass = parsed.password().unwrap_or("");
        if !user.is_empty() {
            options = ConnectOptions::with_user_and_password(user.to_string(), pass.to_string())
                .retry_on_initial_connect()
                .max_reconnects(None)
                .connection_timeout(Duration::from_secs(5))
                .reconnect_delay_callback(|attempts| {
                    Duration::from_secs((1u64 << attempts.min(4)).min(30))
                });
        }
    }
    options
}

fn nats_server_url(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        let user = parsed.username();
        if !user.is_empty() {
            return format!(
                "{}://{}:{}",
                parsed.scheme(),
                parsed.host_str().unwrap_or("localhost"),
                parsed.port().unwrap_or(4222),
            );
        }
    }
    url.to_string()
}

/// Connect to NATS with resilient background reconnect (via `async_nats` ConnectOptions).
pub async fn connect_nats(url: &str) -> Result<Client, ConnectError> {
    apply_url_auth(nats_connect_options(), url)
        .connect(&nats_server_url(url))
        .await
}

/// Resolve the NATS client used for a publish (JetStream context preferred).
pub fn client_for_publish(
    nats: &Option<Client>,
    js: &Option<jetstream::Context>,
) -> Option<Client> {
    js.as_ref()
        .map(|j| j.client())
        .or_else(|| nats.clone())
}

/// Ping before any persistence when a publish will follow. No-op if NATS is not configured.
pub async fn ensure_publish_available(
    nats: &Option<Client>,
    js: &Option<jetstream::Context>,
) -> Result<(), NatsError> {
    match client_for_publish(nats, js) {
        Some(client) => ping(&client).await,
        None => Ok(()),
    }
}

pub async fn ping(client: &Client) -> Result<(), NatsError> {
    let deadline = tokio::time::Instant::now() + NATS_OPERATION_TIMEOUT;
    loop {
        if client.connection_state() == State::Connected {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(NatsError::Unavailable(
                "NATS client is not connected".to_string(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(NatsError::TimedOut);
    }
    tokio::time::timeout(remaining, client.flush())
        .await
        .map_err(|_| NatsError::TimedOut)?
        .map_err(|e| NatsError::Unavailable(format!("NATS flush failed: {e}")))?;
    Ok(())
}

async fn with_operation_retry<T, F, Fut>(mut operation: F) -> Result<T, NatsError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, NatsError>>,
{
    match operation().await {
        Ok(value) => Ok(value),
        Err(first) => match operation().await {
            Ok(value) => Ok(value),
            Err(second) => Err(second.max_severity(first)),
        },
    }
}

impl NatsError {
    fn max_severity(self, other: Self) -> Self {
        match (&self, &other) {
            (Self::TimedOut, _) | (_, Self::TimedOut) => Self::TimedOut,
            (Self::Unavailable(_), Self::Unavailable(_)) => self,
            (Self::Publish(_), Self::Publish(_)) => self,
            _ => self,
        }
    }
}

async fn run_timed<F, T, E>(future: F) -> Result<T, NatsError>
where
    F: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    tokio::time::timeout(NATS_OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| NatsError::TimedOut)?
        .map_err(|e| NatsError::Publish(e.to_string()))
}

pub async fn publish_core(client: &Client, subject: impl Into<String>, payload: Bytes) -> Result<(), NatsError> {
    ping(client).await?;
    let subject = subject.into();
    with_operation_retry(|| async {
        run_timed(client.publish(subject.clone(), payload.clone())).await
    })
    .await
}

pub async fn publish_jetstream(
    js: &jetstream::Context,
    subject: impl Into<String>,
    payload: Bytes,
) -> Result<(), NatsError> {
    ping(&js.client()).await?;
    let subject = subject.into();
    with_operation_retry(|| async {
        tokio::time::timeout(NATS_OPERATION_TIMEOUT, async {
            js.publish(subject.clone(), payload.clone())
                .await
                .map_err(|e| NatsError::Publish(e.to_string()))?
                .await
                .map_err(|e| NatsError::Publish(e.to_string()))
        })
        .await
        .map_err(|_| NatsError::TimedOut)?
        .map(|_| ())
    })
    .await
}

pub fn consumer_backoff(attempt: usize) -> Duration {
    Duration::from_secs((1u64 << attempt.min(4)).min(30))
}

pub async fn sleep_consumer_backoff(attempt: &mut usize) {
    tokio::time::sleep(consumer_backoff(*attempt)).await;
    *attempt = attempt.saturating_add(1);
}

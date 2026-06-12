//! JetStream pull consumer: JSON usage batches → bulk insert into `project_usage_entries`.

use async_nats::jetstream;
use async_nats::jetstream::consumer::pull;
use async_nats::jetstream::stream;
use async_nats::jetstream::AckKind;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use futures::StreamExt;
use std::pin::Pin;
use std::time::Duration;
use uuid::Uuid;

use crate::database::{block_on_db_tokio, DbPool};
use crate::schema::project_usage_entries;
use crate::services::usage_publisher::UsageEntry;

#[derive(Debug, Clone)]
pub struct UsageIngestConfig {
    pub nats_url: String,
    pub stream_name: String,
    pub subject: String,
    pub consumer_name: String,
    pub db_batch_size: usize,
    pub db_max_flush_ms: u64,
}

#[derive(Insertable)]
#[diesel(table_name = project_usage_entries)]
struct NewUsageRow {
    id: Uuid,
    project_id: Uuid,
    recorded_at: DateTime<Utc>,
    kind: String,
    metric: String,
    quantity: i64,
    price_unit: String,
    details: serde_json::Value,
}

impl From<UsageEntry> for NewUsageRow {
    fn from(e: UsageEntry) -> Self {
        Self {
            id: e.id,
            project_id: e.project_id,
            recorded_at: e.recorded_at,
            kind: e.kind,
            metric: e.metric,
            quantity: e.quantity,
            price_unit: e.price_unit,
            details: e.details,
        }
    }
}

struct IngestBuffer {
    rows: Vec<NewUsageRow>,
    messages: Vec<async_nats::jetstream::Message>,
}

impl IngestBuffer {
    fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    fn clear(&mut self) {
        self.rows.clear();
        self.messages.clear();
    }
}

pub async fn run_usage_ingest_listener(
    pool: DbPool,
    config: UsageIngestConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!("[usage_ingest] connecting to NATS JetStream");
    let client = crate::configs::connect_nats(&config.nats_url).await?;
    let js = jetstream::new(client);
    let mut backoff_attempt = 0usize;

    loop {
        let stream = match js
            .get_or_create_stream(stream::Config {
                name: config.stream_name.clone(),
                subjects: vec![config.subject.clone()],
                ..Default::default()
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "[usage_ingest] stream setup failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        let consumer = match stream
            .get_or_create_consumer(
                &config.consumer_name,
                pull::Config {
                    durable_name: Some(config.consumer_name.clone()),
                    filter_subject: config.subject.clone(),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "[usage_ingest] consumer setup failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        let mut messages = match consumer.messages().await {
            Ok(m) => {
                backoff_attempt = 0;
                m
            }
            Err(e) => {
                tracing::error!(error = %e, "[usage_ingest] messages stream failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        let mut buffer = IngestBuffer {
            rows: Vec::with_capacity(config.db_batch_size),
            messages: Vec::new(),
        };
        let max_flush_duration = Duration::from_millis(config.db_max_flush_ms);
        let mut max_flush_deadline: Pin<Box<tokio::time::Sleep>> =
            Box::pin(tokio::time::sleep(Duration::MAX));

        loop {
            tokio::select! {
                msg_result = messages.next() => {
                    match msg_result {
                        Some(Ok(msg)) => {
                            match serde_json::from_slice::<Vec<UsageEntry>>(&msg.payload) {
                                Ok(entries) => {
                                    let was_empty = buffer.rows.is_empty();
                                    buffer.rows.extend(entries.into_iter().map(NewUsageRow::from));
                                    buffer.messages.push(msg);
                                    if was_empty {
                                        max_flush_deadline
                                            .as_mut()
                                            .reset(tokio::time::Instant::now() + max_flush_duration);
                                    }
                                    if buffer.rows.len() >= config.db_batch_size {
                                        if let Err(e) = flush_buffer(&pool, &mut buffer).await {
                                            tracing::error!(error = %e, "[usage_ingest] flush failed");
                                        }
                                        max_flush_deadline
                                            .as_mut()
                                            .reset(tokio::time::Instant::now() + Duration::MAX);
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(error = %e, "[usage_ingest] invalid batch JSON; acking");
                                    if let Err(ack_e) = msg.ack().await {
                                        tracing::error!(error = %ack_e, "[usage_ingest] ack failed");
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            tracing::error!(error = %e, "[usage_ingest] consumer stream error; reconnecting");
                            break;
                        }
                        None => {
                            tracing::warn!("[usage_ingest] consumer stream ended; reconnecting");
                            break;
                        }
                    }
                }
                _ = max_flush_deadline.as_mut(), if !buffer.is_empty() => {
                    if let Err(e) = flush_buffer(&pool, &mut buffer).await {
                        tracing::error!(error = %e, "[usage_ingest] max-age flush failed");
                    }
                    max_flush_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::MAX);
                }
            }
        }

        crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
    }
}

async fn flush_buffer(
    pool: &DbPool,
    buffer: &mut IngestBuffer,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if buffer.is_empty() {
        return Ok(());
    }

    let rows = std::mem::take(&mut buffer.rows);
    let messages = std::mem::take(&mut buffer.messages);
    let count = rows.len();

    let insert_result = block_on_db_tokio(pool, move |conn| {
        diesel::insert_into(project_usage_entries::table)
            .values(&rows)
            .execute(conn)?;
        Ok(())
    })
    .await;

    match insert_result {
        Ok(()) => {
            tracing::info!(count, "[usage_ingest] inserted usage rows");
            for msg in messages {
                if let Err(e) = msg.ack().await {
                    tracing::error!(error = %e, "[usage_ingest] ack failed after insert");
                }
            }
        }
        Err(e) => {
            tracing::error!(error = %e, count, "[usage_ingest] insert failed; naking batch");
            for msg in messages {
                if let Err(nak_e) = msg.ack_with(AckKind::Nak(None)).await {
                    tracing::error!(error = %nak_e, "[usage_ingest] nak failed");
                }
            }
        }
    }

    Ok(())
}

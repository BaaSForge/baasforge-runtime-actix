use async_nats::jetstream;
use futures::StreamExt;
use opentelemetry::trace::FutureExt;
use std::sync::Arc;
use std::time::Duration;
use tracing::Instrument;
use tracing::{error, info, warn};
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::database::DbPool;
use crate::libs::unit_js::actor_runner::ActorKind;
use crate::libs::unit_js::modules::sdk::SdkCommCtx;
use crate::models::actor_store::ActorPgPool;
use crate::routes::ActorLocks;
use crate::services::actor_engine::{ActorRedis, ACTOR_NATS_STREAM_SUBJECTS};
use crate::services::actor_worker::idle::run_actor_idle_sweep;
use crate::services::actor_worker::manager::{ActorRunInput, run_actor_with_lock};
use crate::services::project_release::{
    load_live_release_id_scoped, load_production_runtime_id_for_project,
};
use crate::services::queue_worker_engine::QueueWorkerRedis;
use crate::services::storage_meter::{meter_nats_decr, STORE_NATS_ACTOR};

fn actor_mail_project_id(subject: &str) -> Option<String> {
    subject.split('.').nth(1).map(str::to_string)
}

async fn ack_actor_mail(msg: &async_nats::jetstream::Message, project_id: Option<&str>) {
    let pid = project_id
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| actor_mail_project_id(msg.subject.as_str()));
    if let Some(pid) = pid {
        meter_nats_decr(
            &pid,
            STORE_NATS_ACTOR,
            msg.subject.as_str(),
            msg.payload.as_ref(),
        );
    }
    let _ = msg.ack().await;
}
use crate::services::usage_meter::UsageMeterMemory;
use crate::services::workflow_engine::SharedRedis as WfRedis;
use uuid::Uuid;

pub async fn run_actor_consumer(
    actor_redis: ActorRedis,
    actor_js: Option<jetstream::Context>,
    actor_nats: Option<async_nats::Client>,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    wf_redis: WfRedis,
    wq_redis: QueueWorkerRedis,
    wf_nats: Option<async_nats::Client>,
    wf_js: Option<jetstream::Context>,
    stream_name: &str,
    consumer_name: &str,
    actor_pg: Option<ActorPgPool>,
    locks: ActorLocks,
    idle_sweep_interval: Duration,
    usage_meter: UsageMeterMemory,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(js) = actor_js else {
        info!("[actor_consumer] no JetStream context; mailbox consumer exiting");
        return Ok(());
    };

    let subjects: Vec<String> = ACTOR_NATS_STREAM_SUBJECTS
        .iter()
        .map(|s| s.to_string())
        .collect();

    let filter_subject = "actor.*.*.*.*.msg".to_string();
    let actor_js_for_comm = Some(js.clone());

    let idle_comm = Arc::new(SdkCommCtx {
        pool: pool.clone(),
        redis_conn: redis_conn.clone(),
        wf_redis: wf_redis.clone(),
        wf_nats: wf_nats.clone(),
        wf_js: wf_js.clone(),
        wq_redis: wq_redis.clone(),
        wq_nats: None,
        wq_js: None,
        actor_redis: actor_redis.clone(),
        actor_nats: actor_nats.clone(),
        actor_js: actor_js_for_comm.clone(),
        actor_pg: actor_pg.clone(),
        actor_locks: locks.clone(),
        project_id: String::new(),
        source_unit_path: String::new(),
        source_instance_id: None,
        stage_runtime_id: None,
        resolved_runtime_id: None,
        sdk_public_host: "localhost".to_string(),
        sdk_trigger_base_path: String::new(),
        usage_meter,
    });
    let idle_interval = idle_sweep_interval.max(Duration::from_secs(1));
    tokio::spawn(async move {
        run_actor_idle_sweep(idle_comm, idle_interval).await;
    });

    let mut backoff_attempt = 0usize;
    loop {
        if let Err(e) = js
            .create_or_update_stream(async_nats::jetstream::stream::Config {
                name: stream_name.to_string(),
                subjects: subjects.clone(),
                ..Default::default()
            })
            .await
        {
            error!(error = %e, "[actor_consumer] stream setup failed; retrying");
            crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
            continue;
        }

        let stream = match js.get_stream(stream_name).await {
            Ok(s) => s,
            Err(e) => {
                error!(error = %e, "[actor_consumer] get_stream failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        info!(
            stream = %stream_name,
            consumer = %consumer_name,
            "[actor_consumer] JetStream pull consumer reconnecting"
        );

        let consumer: async_nats::jetstream::consumer::Consumer<
            async_nats::jetstream::consumer::pull::Config,
        > = match stream
            .create_consumer(async_nats::jetstream::consumer::pull::Config {
                durable_name: Some(consumer_name.to_string()),
                filter_subjects: vec![filter_subject.clone()],
                ack_wait: std::time::Duration::from_secs(300),
                ..Default::default()
            })
            .await
        {
            Ok(c) => c,
            Err(e) => {
                error!(error = %e, "[actor_consumer] create_consumer failed; retrying");
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
                error!(error = %e, "[actor_consumer] messages stream failed; retrying");
                crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
                continue;
            }
        };

        while let Some(result) = messages.next().await {
            match result {
                Ok(msg) => {
                    let actor_redis = actor_redis.clone();
                    let actor_nats = actor_nats.clone();
                    let actor_js = actor_js_for_comm.clone();
                    let pool = pool.clone();
                    let redis_conn = redis_conn.clone();
                    let wf_redis = wf_redis.clone();
                    let wq_redis = wq_redis.clone();
                    let wf_nats = wf_nats.clone();
                    let wf_js = wf_js.clone();
                    let locks = locks.clone();

                    let actor_pg = actor_pg.clone();
                    let usage_meter = usage_meter;
                    tokio::spawn(async move {
                        handle_actor_message(
                            msg, actor_redis, actor_js, actor_nats, pool, redis_conn,
                            wf_redis, wq_redis, wf_nats, wf_js, actor_pg, locks, usage_meter,
                        )
                        .await;
                    });
                }
                Err(e) => {
                    error!(error = %e, "[actor_consumer] consumer stream error; reconnecting");
                    break;
                }
            }
        }

        warn!("[actor_consumer] pull stream ended; reconnecting");
        crate::nats::sleep_consumer_backoff(&mut backoff_attempt).await;
    }
}

async fn handle_actor_message(
    msg: async_nats::jetstream::Message,
    actor_redis: ActorRedis,
    actor_js: Option<async_nats::jetstream::Context>,
    actor_nats: Option<async_nats::Client>,
    pool: DbPool,
    redis_conn: crate::database::SharedRedisConn,
    wf_redis: WfRedis,
    wq_redis: QueueWorkerRedis,
    wf_nats: Option<async_nats::Client>,
    wf_js: Option<async_nats::jetstream::Context>,
    actor_pg: Option<ActorPgPool>,
    locks: ActorLocks,
    usage_meter: UsageMeterMemory,
) {
    crate::rt_enter!("actor.consumer.handle_message", subject = %msg.subject);
    let payload: Option<serde_json::Value> = serde_json::from_slice(&msg.payload).ok();
    let Some(payload) = payload else {
        crate::rt_exit_err!("actor.consumer.handle_message", error = "invalid_payload");
        warn!("[actor_consumer] invalid payload, acking");
        ack_actor_mail(&msg, None).await;
        return;
    };

    let pid_o = payload
        .get("projectId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let rid_o = payload
        .get("stageRuntimeId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let trigger_runtime = if rid_o.is_some() {
        Some("stage")
    } else {
        Some("production")
    };
    let corr = crate::telemetry::trigger_correlation_from_payload(&payload);
    let subject = msg.subject.to_string();
    let stage_uuid = rid_o
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());
    let project_uuid_opt = pid_o.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok());
    let release_id_owned = match project_uuid_opt {
        Some(pu) => load_live_release_id_scoped(&pool, &redis_conn, pu, stage_uuid)
            .await
            .ok()
            .flatten()
            .map(|u| u.to_string()),
        None => None,
    };
    let production_runtime_owned = if stage_uuid.is_none() {
        match project_uuid_opt {
            Some(pu) => load_production_runtime_id_for_project(&pool, pu)
                .await
                .ok()
                .flatten()
                .map(|u| u.to_string()),
            None => None,
        }
    } else {
        None
    };
    let unit_path_ref = payload
        .get("unitPath")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let actor_id_ref = payload
        .get("actorId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let handler_ref = payload
        .get("handler")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let extras = crate::telemetry::AsyncConsumerSpanExtras {
        messaging_destination: Some(subject.as_str()),
        baal_unit_path: unit_path_ref,
        baal_actor_instance_id: actor_id_ref,
        baal_release_id: release_id_owned.as_deref(),
        ..Default::default()
    };
    let consumer_cx = crate::telemetry::async_consumer_context(
        &corr,
        "baal.consumer.actor_mailbox",
        "actor_mailbox",
        pid_o.as_deref(),
        trigger_runtime,
        rid_o.as_deref(),
        Some(&extras),
    );

    let env_label: &'static str = if rid_o.is_some() {
        "stage"
    } else {
        "production"
    };
    let dispatch_span = tracing::info_span!(
        "actor.invoke",
        baal.trigger.source = "actor_mailbox",
        baal.app.environment = env_label,
        baal.project.id = pid_o.as_deref().unwrap_or(""),
        baal.unit.path = unit_path_ref.unwrap_or(""),
        baal.actor.instance_id = actor_id_ref.unwrap_or(""),
        baal.actor.handler = handler_ref.unwrap_or(""),
        baal.runtime.id = tracing::field::Empty,
        baal.release.id = tracing::field::Empty,
    );
    dispatch_span.set_parent(consumer_cx.clone());
    if let Some(ref r) = rid_o {
        if !r.is_empty() {
            dispatch_span.record("baal.runtime.id", r.as_str());
        }
    } else if let Some(ref pr) = production_runtime_owned {
        dispatch_span.record("baal.runtime.id", pr.as_str());
    }
    if let Some(ref rel) = release_id_owned {
        dispatch_span.record("baal.release.id", rel.as_str());
    }
    let dispatch_span_run = dispatch_span.clone();

    (async move {
    let project_id = payload
        .get("projectId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let unit_path = payload
        .get("unitPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let actor_id = payload
        .get("actorId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let handler = payload
        .get("handler")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let payload_json = payload
        .get("payload")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let reply_to = payload
        .get("replyTo")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let stage_runtime_id = payload
        .get("stageRuntimeId")
        .and_then(|v| v.as_str())
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    let (Some(project_id), Some(unit_path), Some(actor_id), Some(handler)) =
        (project_id, unit_path, actor_id, handler)
    else {
        warn!("[actor_consumer] missing required fields, acking");
        ack_actor_mail(&msg, None).await;
        return;
    };

    let input = ActorRunInput {
        project_id: project_id.clone(),
        unit_path: unit_path.clone(),
        actor_id: actor_id.clone(),
        handler,
        payload_json,
        kind: ActorKind::Handler,
        alarm_name: None,
        error_msg: None,
    };

    let resolved_runtime_id = match stage_runtime_id {
        Some(rid) => Some(rid),
        None => match Uuid::parse_str(&project_id) {
            Ok(pu) => load_production_runtime_id_for_project(&pool, pu)
                .await
                .ok()
                .flatten(),
            Err(_) => None,
        },
    };

    let comm = Arc::new(SdkCommCtx {
        pool,
        redis_conn,
        wf_redis: wf_redis.clone(),
        wf_nats: wf_nats.clone(),
        wf_js: wf_js.clone(),
        wq_redis: wq_redis.clone(),
        wq_nats: None,
        wq_js: None,
        actor_redis: actor_redis.clone(),
        actor_nats: actor_nats.clone(),
        actor_js,
        actor_pg,
        actor_locks: locks,
        project_id: project_id.clone(),
        source_unit_path: unit_path.clone(),
        source_instance_id: None,
        stage_runtime_id,
        resolved_runtime_id,
        sdk_public_host: "localhost".to_string(),
        sdk_trigger_base_path: String::new(),
        usage_meter,
    });

    let result = run_actor_with_lock(input, comm, None).await;

    if let Some(reply_subject) = reply_to {
        // reply_subject format: "wf.promise.{pid}.{iid}.{pname}"
        let parts: Vec<&str> = reply_subject.split('.').collect();
        if parts.len() == 5 && parts[0] == "wf" && parts[1] == "promise" {
            let (pid, iid, pname) = (parts[2], parts[3], parts[4]);
            match &result {
                Ok(out) => {
                    let value_json = serde_json::to_string(&out.result)
                        .unwrap_or_else(|_| "null".into());
                    if let Err(e) = crate::services::workflow_engine::resolve_promise(
                        &wf_redis, &wf_nats, &wf_js, pid, iid, pname, &value_json,
                    )
                    .await
                    {
                        warn!(error = %e, "[actor_consumer] resolve_promise failed; not acking for redelivery");
                        return;
                    }
                }
                Err(err) => {
                    crate::services::workflow_engine::reject_caller_promise(
                        &wf_redis, &wf_nats, &wf_js, pid, iid, pname, err,
                    )
                    .await;
                }
            }
        }
    }

    crate::rt_exit_ok!("actor.consumer.handle_message", subject = %msg.subject);
    ack_actor_mail(&msg, Some(&project_id)).await;
    })
    .instrument(dispatch_span_run)
    .with_context(consumer_cx)
    .await;
}

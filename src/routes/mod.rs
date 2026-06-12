pub mod actor;
pub mod queue_worker;
pub mod unit;
pub mod workflow;
pub mod ws;

use crate::configs::Settings;
use crate::database::{establish_pool, DbPool, SharedRedisConn};
use crate::libs::unit_js::modules::sdk::SdkActorLocks;
use crate::models::actor_store::{build_actor_pg_pool, ActorPgPool};
use crate::services::actor_engine::ActorRedis;
use crate::services::workflow_engine::SharedRedis;
use actix_web::Result;
use actix_web::web;
use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppContext {
    pub pool: DbPool,
    pub settings: Settings,
    pub redis_conn: SharedRedisConn,
    /// Dedicated Redis connection for workflow state (step results, promises, timers).
    pub wf_redis: SharedRedis,
    /// NATS client for workflow wake signals and lifecycle events.
    pub wf_nats_client: Option<async_nats::Client>,
    /// JetStream context for durable workflow wake timer publishes.
    pub wf_jetstream: Option<async_nats::jetstream::Context>,
    /// Dedicated Redis connection for queue worker state (run metadata, results, locks).
    pub wq_redis: SharedRedis,
    /// NATS client for queue worker work queue (JetStream) and lifecycle events (Core).
    pub wq_nats_client: Option<async_nats::Client>,
    /// JetStream context for publishing queue worker work messages.
    pub wq_jetstream: Option<async_nats::jetstream::Context>,

    /// Dedicated Redis connection for actor state (snapshots, leases, alarms).
    pub actor_redis: ActorRedis,
    /// NATS client for actor mailbox (JetStream) and lifecycle events (Core).
    pub actor_nats_client: Option<async_nats::Client>,
    /// JetStream context for publishing actor mailbox messages.
    pub actor_jetstream: Option<async_nats::jetstream::Context>,
    pub actor_pg: Option<ActorPgPool>,
    /// Per-actor execution locks: (project_id, unit_path, actor_id, stage_runtime_id) → mutex.
    pub actor_locks: ActorLocks,
}

pub type ActorLocks = SdkActorLocks;

impl AppContext {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pool: DbPool,
        settings: Settings,
        redis_conn: SharedRedisConn,
        wf_redis: SharedRedis,
        wf_nats_client: Option<async_nats::Client>,
        wf_jetstream: Option<async_nats::jetstream::Context>,
        wq_redis: SharedRedis,
        wq_nats_client: Option<async_nats::Client>,
        wq_jetstream: Option<async_nats::jetstream::Context>,
        actor_redis: ActorRedis,
        actor_nats_client: Option<async_nats::Client>,
        actor_jetstream: Option<async_nats::jetstream::Context>,
        actor_pg: Option<ActorPgPool>,
        actor_locks: ActorLocks,
    ) -> Self {
        Self {
            pool,
            settings,
            redis_conn,
            wf_redis,
            wf_nats_client,
            wf_jetstream,
            wq_redis,
            wq_nats_client,
            wq_jetstream,
            actor_redis,
            actor_nats_client,
            actor_jetstream,
            actor_pg,
            actor_locks,
        }
    }
}

pub async fn start_server() -> Result<(), Box<dyn Error>> {
    use actix_web::{App, HttpServer};

    let settings = Settings::new()?;
    let port = settings
        .port
        .parse::<u16>()
        .expect("Failed to parse port number");

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
        settings.database_pool_idle_timeout_secs,
    );
    crate::configs::start_usage_publisher_if_enabled(&settings);
    let redis_conn = crate::database::connect_shared_redis_cache(
        settings.redis_cache_enabled,
        &settings.redis_url,
    )
    .await
    .map_err(|e| -> Box<dyn Error> { e.into() })?;
    let wf_redis = crate::database::connect_redis(&settings.wf_redis_url).await?;
    tracing::info!("[wf_redis] workflow Redis connected");

    let wf_nats_client: Option<async_nats::Client> = if let Some(url) = &settings.wf_nats_url {
        let client = crate::configs::connect_nats(url).await.map_err(|e| -> Box<dyn Error> {
            format!("[nats_wf] connect failed (check WF_NATS_URL): {e}").into()
        })?;
        tracing::info!("[nats_wf] NATS client ready (background reconnect enabled)");
        Some(client)
    } else {
        tracing::info!("[nats_wf] WF_NATS_URL not set, workflow timers disabled");
        None
    };

    let wf_jetstream: Option<async_nats::jetstream::Context> =
        wf_nats_client.as_ref().map(|c| async_nats::jetstream::new(c.clone()));

    let wq_redis = crate::database::connect_redis(&settings.wq_redis_url).await?;
    tracing::info!("[wq_redis] queue worker Redis connected");

    let wq_nats_client: Option<async_nats::Client> = if let Some(url) = &settings.wq_nats_url {
        let client = crate::configs::connect_nats(url).await.map_err(|e| -> Box<dyn Error> {
            format!("[nats_wq] connect failed (check WQ_NATS_URL): {e}").into()
        })?;
        tracing::info!("[nats_wq] NATS client ready (background reconnect enabled)");
        Some(client)
    } else {
        tracing::info!("[nats_wq] WQ_NATS_URL not set, queue workers disabled");
        None
    };

    let wq_jetstream: Option<async_nats::jetstream::Context> =
        wq_nats_client.as_ref().map(|c| async_nats::jetstream::new(c.clone()));

    let actor_redis = crate::database::connect_redis(&settings.actor_redis_url).await?;
    tracing::info!("[actor_redis] actor Redis connected");

    let actor_nats_client: Option<async_nats::Client> = if let Some(url) = &settings.actor_nats_url {
        let client = crate::configs::connect_nats(url).await.map_err(|e| -> Box<dyn Error> {
            format!("[nats_actor] connect failed (check ACTOR_NATS_URL): {e}").into()
        })?;
        tracing::info!("[nats_actor] NATS client ready (background reconnect enabled)");
        Some(client)
    } else {
        tracing::info!("[nats_actor] ACTOR_NATS_URL not set; actor NATS disabled");
        None
    };

    let actor_jetstream: Option<async_nats::jetstream::Context> =
        actor_nats_client.as_ref().map(|c| async_nats::jetstream::new(c.clone()));

    let actor_pg: Option<ActorPgPool> = settings.actor_database_url.as_ref().map(|url| {
        build_actor_pg_pool(
            url,
            settings.actor_database_pool_size.max(1),
            settings.actor_database_connection_timeout_secs.max(1),
            settings.actor_database_pool_idle_timeout_secs,
        )
    });
    if actor_pg.is_some() {
        tracing::info!("[actor_pg] ACTOR_DATABASE_URL configured; actor snapshots will persist to Actor Postgres");
    }

    let actor_locks: ActorLocks = Arc::new(Mutex::new(HashMap::new()));

    // In test mode, run the JetStream consumers in-process (normally handled
    // by the separate worker binaries).
    let mut test_mode_tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    if settings.test_mode {
        if let Some(nc) = &wf_nats_client {
            let wr = wf_redis.clone();
            let nc = nc.clone();
            let p = pool.clone();
            let rc = redis_conn.clone();
            let stream_name = settings
                .wf_nats_jetstream_stream
                .as_deref()
                .unwrap_or("WF_WAKE")
                .to_string();
            let consumer_name = settings
                .wf_nats_jetstream_consumer
                .as_deref()
                .unwrap_or("wf_wake_consumer")
                .to_string();
            tracing::info!("[test_mode] starting inline JetStream wake consumer");
            let actor_redis_wake = actor_redis.clone();
            let actor_nats_wake = actor_nats_client.clone();
            let actor_js_wake = actor_jetstream.clone();
            let actor_locks_wake = actor_locks.clone();
            let wq_redis_wake = wq_redis.clone();
            let wq_nats_wake = wq_nats_client.clone();
            let wq_js_wake = wq_jetstream.clone();
            let actor_pg_wake = actor_pg.clone();
            let usage_meter_wake = settings.usage_meter;
            test_mode_tasks.push(tokio::spawn(async move {
                if let Err(e) = crate::services::workflow_worker::runner::run_wake_consumer(
                    wr,
                    nc,
                    p,
                    rc,
                    &stream_name,
                    &consumer_name,
                    actor_redis_wake,
                    actor_nats_wake,
                    actor_js_wake,
                    actor_pg_wake,
                    actor_locks_wake,
                    wq_redis_wake,
                    wq_nats_wake,
                    wq_js_wake,
                    usage_meter_wake,
                )
                .await
                {
                    tracing::error!(error = %e, "[test_mode] wake consumer exited with error");
                }
            }));
        }

        if let Some(nc) = &wq_nats_client {
            let wr = wq_redis.clone();
            let nc = nc.clone();
            let p = pool.clone();
            let rc = redis_conn.clone();
            let wf_redis_for_wq = wf_redis.clone();
            let wf_nats_for_wq = wf_nats_client.clone();
            let actor_redis_for_wq = actor_redis.clone();
            let actor_nats_for_wq = actor_nats_client.clone();
            let actor_js_for_wq = actor_jetstream.clone();
            let actor_locks_for_wq = actor_locks.clone();
            let actor_pg_for_wq = actor_pg.clone();
            let stream_name = crate::services::queue_worker_engine::WQ_NATS_WORK_STREAM.to_string();
            let consumer_name = crate::services::queue_worker_engine::WQ_NATS_WORK_CONSUMER.to_string();
            let usage_meter_wq = settings.usage_meter;
            tracing::info!("[test_mode] starting inline JetStream queue_worker work consumer");
            test_mode_tasks.push(tokio::spawn(async move {
                if let Err(e) =
                    crate::services::queue_worker_worker::runner::run_work_consumer(
                        wr,
                        nc,
                        p,
                        rc,
                        &stream_name,
                        &consumer_name,
                        wf_redis_for_wq,
                        wf_nats_for_wq,
                        actor_redis_for_wq,
                        actor_nats_for_wq,
                        actor_js_for_wq,
                        actor_pg_for_wq,
                        actor_locks_for_wq,
                        usage_meter_wq,
                    )
                    .await
                {
                    tracing::error!(error = %e, "[test_mode] queue_worker work consumer exited with error");
                }
            }));
        }

        {
            let ar = actor_redis.clone();
            let actor_js = actor_jetstream.clone();
            let actor_nc = actor_nats_client.clone();
            let p = pool.clone();
            let rc = redis_conn.clone();
            let wf_redis_for_actor = wf_redis.clone();
            let wq_redis_for_actor = wq_redis.clone();
            let wf_nats_for_actor = wf_nats_client.clone();
            let wf_js_for_actor = wf_jetstream.clone();
            let stream_name = settings
                .actor_nats_jetstream_stream
                .clone()
                .unwrap_or_else(|| crate::services::actor_engine::ACTOR_NATS_STREAM.to_string());
            let consumer_name = settings
                .actor_nats_jetstream_consumer
                .clone()
                .unwrap_or_else(|| crate::services::actor_engine::ACTOR_NATS_CONSUMER.to_string());
            let locks = actor_locks.clone();
            let actor_pg_consumer = actor_pg.clone();
            let actor_idle_sweep = std::time::Duration::from_secs(settings.actor_idle_sweep_secs.max(1));
            let usage_meter_actor = settings.usage_meter;
            tracing::info!("[test_mode] starting inline actor mailbox consumer");
            test_mode_tasks.push(tokio::spawn(async move {
                if let Err(e) =
                    crate::services::actor_worker::runner::run_actor_consumer(
                        ar, actor_js, actor_nc, p, rc,
                        wf_redis_for_actor, wq_redis_for_actor, wf_nats_for_actor, wf_js_for_actor,
                        &stream_name, &consumer_name, actor_pg_consumer, locks,
                        actor_idle_sweep, usage_meter_actor,
                    )
                    .await
                {
                    tracing::error!(error = %e, "[test_mode] actor consumer exited with error");
                }
            }));

            let ar2 = actor_redis.clone();
            let actor_nc2 = actor_nats_client.clone();
            let actor_js2 = actor_jetstream.clone();
            let p2 = pool.clone();
            let rc2 = redis_conn.clone();
            let locks2 = actor_locks.clone();
            let actor_pg_alarm = actor_pg.clone();
            let wf_redis_alarm = wf_redis.clone();
            let wq_redis_alarm = wq_redis.clone();
            let wf_nats_alarm = wf_nats_client.clone();
            let wf_js_alarm = wf_jetstream.clone();
            let wq_nats_alarm = wq_nats_client.clone();
            let wq_js_alarm = wq_jetstream.clone();
            let usage_meter = settings.usage_meter;
            tracing::info!("[test_mode] starting inline actor alarm sweeper");
            test_mode_tasks.push(tokio::spawn(async move {
                use std::sync::Arc;
                let comm = Arc::new(crate::libs::unit_js::modules::sdk::SdkCommCtx {
                    pool: p2,
                    redis_conn: rc2,
                    wf_redis: wf_redis_alarm,
                    wf_nats: wf_nats_alarm,
                    wf_js: wf_js_alarm,
                    wq_redis: wq_redis_alarm,
                    wq_nats: wq_nats_alarm,
                    wq_js: wq_js_alarm,
                    actor_redis: ar2,
                    actor_nats: actor_nc2,
                    actor_js: actor_js2,
                    actor_pg: actor_pg_alarm,
                    actor_locks: locks2,
                    project_id: String::new(),
                    source_unit_path: String::new(),
                    source_instance_id: None,
                    stage_runtime_id: None,
                    resolved_runtime_id: None,
                    sdk_public_host: "localhost".to_string(),
                    sdk_trigger_base_path: String::new(),
                    usage_meter,
                });
                crate::services::actor_worker::alarms::run_alarm_sweeper(comm).await;
            }));
        }

        if let Some(handle) =
            crate::configs::spawn_usage_ingest_listener_if_enabled(&settings, pool.clone())
        {
            tracing::info!("[test_mode] starting inline usage ingest listener");
            test_mode_tasks.push(handle);
        } else if settings.usage_ingest_enabled {
            tracing::warn!(
                "[test_mode] usage ingest config incomplete; usage rows will not persist to DB"
            );
        }

        if let Err(e) =
            crate::services::test_seed::clear_test_project_runtime_redis_cache(&redis_conn).await
        {
            tracing::warn!(
                error = %e,
                "[test_mode] could not clear project-runtime Redis cache (stale unit rows may persist)"
            );
        }
        tracing::info!("[test_mode] seeding test entities into database");
        crate::services::test_seed::seed_test_entities(&pool, &settings);
        crate::services::test_seed::print_trigger_urls(&settings);
    }

    let test_mode_teardown = if settings.test_mode {
        Some(crate::services::test_seed::TestModeTeardown {
            pool: pool.clone(),
            settings: settings.clone(),
            redis_conn: redis_conn.clone(),
            actor_pg: actor_pg.clone(),
            wf_redis: wf_redis.clone(),
            wq_redis: wq_redis.clone(),
            actor_redis: actor_redis.clone(),
            wf_jetstream: wf_jetstream.clone(),
            wq_jetstream: wq_jetstream.clone(),
            actor_jetstream: actor_jetstream.clone(),
        })
    } else {
        None
    };

    let app_context = AppContext::new(
        pool.clone(),
        settings.clone(),
        redis_conn,
        wf_redis,
        wf_nats_client,
        wf_jetstream,
        wq_redis,
        wq_nats_client,
        wq_jetstream,
        actor_redis,
        actor_nats_client,
        actor_jetstream,
        actor_pg,
        actor_locks,
    );

    use actix_cors::Cors;
    use actix_web::guard;
    use actix_web::http::header::HeaderName;
    use actix_web::middleware::from_fn;

    HttpServer::new(move || {
        App::new()
            .wrap(from_fn(crate::middlewares::trace_request_middleware))
            .wrap(
                Cors::default()
                    .allowed_origin_fn(|_origin, _req| true)
                    .supports_credentials()
                    .allow_any_method()
                    .allow_any_header()
                    .expose_headers([
                        HeaderName::from_static("traceparent"),
                        HeaderName::from_static("tracestate"),
                        HeaderName::from_static("x-trace-id"),
                    ]),
            )
            .app_data(web::Data::new(app_context.clone()))
            .route(
                "/api/v1/ws/{project_id}/stage/{runtime_id}",
                web::get().to(ws::ws_project_events_stage),
            )
            .route(
                "/api/v1/ws/{project_id}",
                web::get().to(ws::ws_project_events),
            )
            .service(
                web::scope("/api/v1/trigger/wf")
                    // -- Stage routes (must be registered first so `/stage/` is not swallowed by the production catch-all) --
                    .route(
                        "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/handlers/{handler_name}",
                        web::post().to(workflow::call_shared_handler_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/status",
                        web::get().to(workflow::get_workflow_status_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/cancel",
                        web::post().to(workflow::cancel_workflow_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/result",
                        web::get().to(workflow::get_workflow_result_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{workflow_name_slug}",
                        web::post().to(workflow::start_workflow_stage),
                    )
                    // -- Production routes --
                    .route(
                        "/{project_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/handlers/{handler_name}",
                        web::post().to(workflow::call_shared_handler_production),
                    )
                    .route(
                        "/{project_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/status",
                        web::get().to(workflow::get_workflow_status_production),
                    )
                    .route(
                        "/{project_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/cancel",
                        web::post().to(workflow::cancel_workflow_production),
                    )
                    .route(
                        "/{project_id}/{context_slug}/{module_slug}/{workflow_name_slug}/{instance_id}/result",
                        web::get().to(workflow::get_workflow_result_production),
                    )
                    .route(
                        "/{project_id}/{context_slug}/{module_slug}/{workflow_name_slug}",
                        web::post().to(workflow::start_workflow_production),
                    ),
            )
            .service(
                web::scope("/api/v1/trigger/actor")
                    .route(
                        "/{project_id}/stage/{runtime_id}/{tail:.*}",
                        web::post().to(actor::handle_actor_post_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{tail:.*}",
                        web::get().to(actor::handle_actor_get_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{tail:.*}",
                        web::delete().to(actor::handle_actor_delete_stage),
                    )
                    .route(
                        "/{project_id}/{tail:.*}",
                        web::post().to(actor::handle_actor_post),
                    )
                    .route(
                        "/{project_id}/{tail:.*}",
                        web::get().to(actor::handle_actor_get),
                    )
                    .route(
                        "/{project_id}/{tail:.*}",
                        web::delete().to(actor::handle_actor_delete),
                    ),
            )
            .service(
                web::scope("/api/v1/trigger/workerQueue")
                    .route(
                        "/{project_id}/stage/{runtime_id}/{tail:.*}",
                        web::post().to(queue_worker::handle_queue_worker_post_stage),
                    )
                    .route(
                        "/{project_id}/stage/{runtime_id}/{tail:.*}",
                        web::get().to(queue_worker::handle_queue_worker_get_stage),
                    )
                    .route(
                        "/{project_id}/{tail:.*}",
                        web::post().to(queue_worker::handle_queue_worker_post),
                    )
                    .route(
                        "/{project_id}/{tail:.*}",
                        web::get().to(queue_worker::handle_queue_worker_get),
                    ),
            )
            .service(
                web::scope("/api/v1/trigger")
                    .service(
                        web::resource(
                            "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{unit_name_slug}",
                        )
                        .route(
                            web::route()
                                .guard(guard::Any(guard::Get()).or(guard::Post()).or(guard::Put()).or(guard::Patch()).or(guard::Delete()).or(guard::Head()).or(guard::Options()))
                                .to(unit::handle_trigger_api_unit_stage),
                        ),
                    )
                    .service(
                        web::resource("/{project_id}/{context_slug}/{module_slug}/{unit_name_slug}")
                            .route(
                                web::route()
                                    .guard(guard::Any(guard::Get()).or(guard::Post()).or(guard::Put()).or(guard::Patch()).or(guard::Delete()).or(guard::Head()).or(guard::Options()))
                                    .to(unit::handle_trigger_api_unit_production),
                            ),
                    ),
            )
    })
    .worker_max_blocking_threads(settings.api_worker_max_blocking_threads)
    .bind(("0.0.0.0", port))?
    .run()
    .await?;

    crate::shutdown_telemetry();

    for task in test_mode_tasks {
        task.abort();
    }

    if let Some(td) = test_mode_teardown {
        td.run().await;
    }

    Ok(())
}

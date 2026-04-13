pub mod unit;
pub mod workflow;

use crate::configs::Settings;
use crate::database::{establish_pool, DbPool, SharedRedisConn};
use crate::services::workflow_engine::SharedRedis;
use actix_web::Result;
use actix_web::web;
use std::error::Error;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppContext {
    pub pool: DbPool,
    pub settings: Settings,
    pub redis_conn: SharedRedisConn,
    /// Dedicated Redis connection for workflow state (separate from cache Redis).
    pub wf_redis: Option<SharedRedis>,
    /// NATS client for workflow wake signals.
    pub nats_client: Option<async_nats::Client>,
}

impl AppContext {
    pub fn new(
        pool: DbPool,
        settings: Settings,
        redis_conn: SharedRedisConn,
        wf_redis: Option<SharedRedis>,
        nats_client: Option<async_nats::Client>,
    ) -> Self {
        Self {
            pool,
            settings,
            redis_conn,
            wf_redis,
            nats_client,
        }
    }
}

pub async fn start_server() -> Result<(), Box<dyn Error>> {
    use actix_web::{App, HttpServer};

    crate::init_tracing();

    let settings = Settings::new()?;
    let port = settings
        .port
        .parse::<u16>()
        .expect("Failed to parse port number");

    let pool = establish_pool(
        settings.pg_database_url.clone(),
        settings.database_pool_size,
        settings.database_connection_timeout_secs,
    );
    let redis_conn: SharedRedisConn = if !settings.redis_cache_enabled {
        tracing::info!("[redis] cache disabled (REDIS_CACHE_ENABLED=false); skipping connection");
        None
    } else {
        match redis::Client::open(settings.redis_url.as_str()) {
            Ok(client) => match client.get_multiplexed_async_connection().await {
                Ok(conn) => {
                    tracing::info!("[redis] publish connection connected");
                    Some(Arc::new(Mutex::new(conn)))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "[redis] publish connection failed");
                    None
                }
            },
            Err(e) => {
                tracing::warn!(error = %e, "[redis] client open failed");
                None
            }
        }
    };
    let wf_redis: Option<SharedRedis> = if let Some(url) = &settings.wf_redis_url {
        match redis::Client::open(url.as_str()) {
            Ok(client) => match client.get_multiplexed_async_connection().await {
                Ok(conn) => {
                    tracing::info!("[wf_redis] workflow Redis connected");
                    Some(Arc::new(Mutex::new(conn)))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "[wf_redis] connection failed, workflows disabled");
                    None
                }
            },
            Err(e) => {
                tracing::warn!(error = %e, "[wf_redis] client open failed, workflows disabled");
                None
            }
        }
    } else {
        tracing::info!("[wf_redis] WF_REDIS_URL not set, workflows disabled");
        None
    };

    let nats_client: Option<async_nats::Client> = if let Some(url) = &settings.wf_nats_url {
        match crate::configs::connect_nats(url).await {
            Ok(client) => {
                tracing::info!("[nats_wf] connected for workflow signals");
                Some(client)
            }
            Err(e) => {
                tracing::warn!(error = %e, "[nats_wf] connection failed, workflow timers disabled");
                None
            }
        }
    } else {
        tracing::info!("[nats_wf] WF_NATS_URL not set, workflow timers disabled");
        None
    };

    // In test mode, run the NATS wake consumer in-process (normally handled
    // by the separate runtime_worker binary).
    if settings.test_mode {
        if let (Some(wr), Some(nc)) = (&wf_redis, &nats_client) {
            let wr = wr.clone();
            let nc = nc.clone();
            let p = pool.clone();
            let rc = redis_conn.clone();
            tracing::info!("[test_mode] starting inline NATS wake consumer");
            tokio::spawn(async move {
                if let Err(e) =
                    crate::services::runtime_worker::runner::run_wake_consumer(wr, nc, p, rc).await
                {
                    tracing::error!(error = %e, "[test_mode] wake consumer exited with error");
                }
            });
        }

        tracing::info!("[test_mode] seeding test entities into database");
        crate::services::test_seed::seed_test_entities(&pool, &settings);
        crate::services::test_seed::print_trigger_urls(&settings);
    }

    let app_context = AppContext::new(
        pool.clone(),
        settings.clone(),
        redis_conn,
        wf_redis,
        nats_client,
    );

    let test_pool = if settings.test_mode { Some(pool) } else { None };

    use actix_web::guard;

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(app_context.clone()))
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
    .bind(("127.0.0.1", port))?
    .run()
    .await?;

    if let Some(pool) = test_pool {
        crate::services::test_seed::teardown_test_entities(&pool);
    }

    Ok(())
}

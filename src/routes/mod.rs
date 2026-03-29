pub mod unit;

use crate::configs::Settings;
use crate::database::{establish_pool, DbPool, SharedRedisConn};
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
}

impl AppContext {
    pub fn new(
        pool: DbPool,
        settings: Settings,
        redis_conn: SharedRedisConn,
    ) -> Self {
        Self {
            pool,
            settings,
            redis_conn,
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
    let redis_conn: SharedRedisConn = match redis::Client::open(settings.redis_url.as_str()) {
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
    };
    let app_context = AppContext::new(
        pool,
        settings.clone(),
        redis_conn,
    );

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(app_context.clone()))
            .service(
                web::scope("/api/v1/trigger")
                    .route(
                        "/{project_id}/stage/{runtime_id}/{context_slug}/{module_slug}/{unit_name_slug}",
                        web::get().to(unit::handle_trigger_api_unit_stage),
                    )
                    .route(
                        "/{project_id}/{context_slug}/{module_slug}/{unit_name_slug}",
                        web::get().to(unit::handle_trigger_api_unit_production),
                    )
            )
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await?;

    Ok(())
}

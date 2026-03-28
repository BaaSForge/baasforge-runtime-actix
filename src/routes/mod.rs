pub mod project;

use crate::configs::Settings;
use crate::database::{DbPool, establish_pool};
use actix_web::Result;
use actix_web::web;
use std::error::Error;
use std::sync::Arc;
use tokio::sync::Mutex;

pub type SharedRedisConn = Option<Arc<Mutex<redis::aio::MultiplexedConnection>>>;

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
                log::info!("[redis] Publish connection connected");
                Some(Arc::new(Mutex::new(conn)))
            }
            Err(e) => {
                log::warn!("[redis] Publish connection failed: {}", e);
                None
            }
        },
        Err(e) => {
            log::warn!("[redis] Client open failed: {}", e);
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
                web::scope("/api/v1/platform")
                    .route(
                        "/projects/{id}",
                        web::get()
                            .to(project::handle_get_project),
                    )
            )
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await?;

    Ok(())
}

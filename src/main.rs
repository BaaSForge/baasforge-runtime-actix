use baal_runtime_actix::init_tracing;
use baal_runtime_actix::libs::unit_js::module_loader::init_tokio_handle;
use baal_runtime_actix::routes;
use rustls::crypto::ring::default_provider;

#[actix_web::main]
async fn main() -> Result<(), actix_web::Error> {
    init_tracing("api_server");

    default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    init_tokio_handle(tokio::runtime::Handle::current());

    routes::start_server().await?;

    Ok(())
}

use baal_runtime_actix::init_tracing;
use baal_runtime_actix::routes;
use rustls::crypto::ring::default_provider;

#[actix_web::main]
async fn main() -> Result<(), actix_web::Error> {
    init_tracing();

    default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    routes::start_server().await?;

    Ok(())
}

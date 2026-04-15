use baal_runtime_actix::services::workflow_worker::runner;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    runner::run().await
}

pub mod nats;
pub mod runtime_trace;
pub mod actor_schema;
pub mod configs;
pub mod database;
pub mod libs;
pub mod middlewares;
pub mod models;
pub mod routes;
pub mod schema;
pub mod services;
pub mod telemetry;

pub fn init_tracing(service_name: &'static str) {
    telemetry::init_tracing(service_name);
}

pub fn shutdown_telemetry() {
    telemetry::shutdown();
}

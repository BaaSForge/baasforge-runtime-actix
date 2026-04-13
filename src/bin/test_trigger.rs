//! Minimal trigger server for running a local JS file through the QuickJS runtime.
//!
//! No database, Redis, or NATS required — just reads compiled JS from disk and
//! serves it at every path so that self-fetch URL rewrites work transparently.
//!
//! ```sh
//! UNIT_JS_FILE=units/runtime-check/dist/index.js PORT=3333 cargo run --bin test_trigger
//! ```

use actix_web::http::StatusCode;
use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer};
use baal_runtime_actix::libs::unit_js::{self, TriggerHttpSnapshot};
use std::sync::Arc;
use std::time::Duration;

const MAX_BODY: usize = 512 * 1024;
/// Per-request execution timeout.  The health-check has ~400 tests including
/// self-fetch round-trips, so the main `GET /` can be slow in debug builds.
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);

struct State {
    js_source: String,
    port: u16,
}

async fn handle(
    data: web::Data<Arc<State>>,
    req: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    if body.len() > MAX_BODY {
        return HttpResponse::PayloadTooLarge().body("request body too large");
    }

    let method = req.method().as_str().to_string();
    let raw_path = req.uri().path();

    // In production the trigger prefix is stripped and the unit always sees
    // `req.url` as `/?query`.  For the test server we need to preserve the
    // actual path so the JS code can differentiate `GET /` from
    // `GET /nonexistent` (the health-check tests a 404 via a non-root path).
    // We strip a well-known trigger prefix when present so self-fetch
    // rewrite URLs behave identically to production.
    let canonical_trigger: &str = &std::env::var("TRIGGER_PATH").unwrap_or_default();
    let visible_path = if !canonical_trigger.is_empty() && raw_path.starts_with(canonical_trigger)
    {
        let rest = &raw_path[canonical_trigger.len()..];
        if rest.is_empty() { "/" } else { rest }
    } else if raw_path == "/" {
        "/"
    } else {
        raw_path
    };

    let url = match req.uri().query() {
        Some(q) => format!("{visible_path}?{q}"),
        None => visible_path.to_string(),
    };
    let trigger_path = req.uri().path().to_string();

    let mut header_pairs = Vec::new();
    for (name, value) in req.headers().iter() {
        let mut v = value.to_str().unwrap_or("").to_string();
        if name.as_str().eq_ignore_ascii_case("host") && !v.contains(':') {
            v = format!("{v}:{}", data.port);
        }
        header_pairs.push((name.as_str().to_string(), v));
    }
    let body_text = String::from_utf8_lossy(&body).into_owned();

    let snapshot = TriggerHttpSnapshot {
        method,
        url,
        header_pairs,
        body_text,
        trigger_path,
    };

    let source = data.js_source.clone();
    let run_result = match tokio::time::timeout(
        EXEC_TIMEOUT,
        tokio::task::spawn_blocking(move || unit_js::run_unit_handler(&source, &snapshot)),
    )
    .await
    {
        Ok(Ok(Ok(r))) => r,
        Ok(Ok(Err(e))) => {
            tracing::error!(error = %e, "QuickJS execution failed");
            return HttpResponse::InternalServerError().body(format!("JS error: {e}"));
        }
        Ok(Err(e)) => {
            tracing::error!(error = %e, "spawn_blocking failed");
            return HttpResponse::InternalServerError().body("task error");
        }
        Err(_) => {
            tracing::error!("QuickJS execution timed out after {}s", EXEC_TIMEOUT.as_secs());
            return HttpResponse::GatewayTimeout()
                .body(format!("execution timed out after {}s", EXEC_TIMEOUT.as_secs()));
        }
    };

    let status =
        StatusCode::from_u16(run_result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut resp = HttpResponse::build(status);
    for (name, value) in run_result.headers {
        resp.append_header((name, value));
    }
    resp.body(run_result.body)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    baal_runtime_actix::init_tracing();

    let file_path = std::env::var("UNIT_JS_FILE").expect("UNIT_JS_FILE env var is required");
    let js_source = std::fs::read_to_string(&file_path)
        .unwrap_or_else(|e| panic!("cannot read {file_path}: {e}"));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3333);

    tracing::info!(file = %file_path, port, "test_trigger: starting");

    let state = Arc::new(State { js_source, port });

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .app_data(web::PayloadConfig::new(MAX_BODY))
            .default_service(web::route().to(handle))
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}

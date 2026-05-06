use opentelemetry::{global, Context};
use rquickjs::{Ctx, Exception, Object, Value, function::Func};
use std::collections::HashMap;

use crate::libs::unit_js::modules::helpers;

const FETCH_JS: &str = include_str!("../scripts/fetch.js");

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__fetch_sync", Func::from(fetch_sync))?;
    ctx.eval::<(), _>(FETCH_JS)?;
    ctx.eval::<(), _>("delete globalThis.__fetch_sync")?;
    Ok(())
}

/// Replace `localhost` with `127.0.0.1` to avoid IPv6 `::1` resolution
/// on macOS where the server only binds to IPv4.
fn normalize_url(url: &str) -> String {
    if url.ends_with("://localhost") {
        return url.replace("://localhost", "://127.0.0.1");
    }
    url.replace("://localhost:", "://127.0.0.1:")
        .replace("://localhost/", "://127.0.0.1/")
        .replace("://localhost?", "://127.0.0.1?")
}

fn merge_outbound_trace_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let has_tp = headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("traceparent"));
    if has_tp {
        return headers.to_vec();
    }
    let mut out = headers.to_vec();
    let mut carrier = HashMap::<String, String>::new();
    global::get_text_map_propagator(|p| {
        p.inject_context(&Context::current(), &mut carrier);
    });
    for (k, v) in carrier {
        if k.eq_ignore_ascii_case("traceparent") || k.eq_ignore_ascii_case("tracestate") {
            out.push((k, v));
        }
    }
    out
}

fn do_request(
    raw_url: &str,
    method: &str,
    headers: &[(String, String)],
    body: &str,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let url = normalize_url(raw_url);
    let url = url.as_str();
    let headers = merge_outbound_trace_headers(headers);
    let url_for_trace = raw_url.split('?').next().unwrap_or(raw_url);
    let span = tracing::debug_span!(
        "http.client.request",
        http.request.method = %method,
        http.url = %url_for_trace,
        http.response.status_code = tracing::field::Empty,
    );
    let _g = span.enter();
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build(),
    );

    macro_rules! no_body {
        ($req:expr) => {{
            let mut r = $req;
            for (n, v) in &headers { r = r.header(n, v); }
            r.call().map_err(|e| format!("{e}"))
        }};
    }

    macro_rules! with_body {
        ($req:expr) => {{
            let mut r = $req;
            for (n, v) in &headers { r = r.header(n, v); }
            r.send(body.as_bytes()).map_err(|e| format!("{e}"))
        }};
    }

    let resp = match method {
        "GET" => no_body!(agent.get(url)),
        "HEAD" => no_body!(agent.head(url)),
        "DELETE" => no_body!(agent.delete(url)),
        "POST" => with_body!(agent.post(url)),
        "PUT" => with_body!(agent.put(url)),
        "PATCH" => with_body!(agent.patch(url)),
        "OPTIONS" => no_body!(agent.options(url)),
        other => return Err(format!("Unsupported HTTP method: {other}")),
    }?;

    let status = resp.status();
    span.record(
        "http.response.status_code",
        u16::from(status) as u64,
    );

    let mut resp_headers: Vec<(String, String)> = Vec::new();
    for (name, value) in resp.headers() {
        let v = value.to_str().unwrap_or("").to_string();
        resp_headers.push((name.as_str().to_string(), v));
    }

    let body_bytes = resp
        .into_body()
        .read_to_vec()
        .map_err(|e| format!("{e}"))?;

    Ok((u16::from(status), resp_headers, body_bytes))
}

fn fetch_sync<'js>(
    ctx: Ctx<'js>,
    url: String,
    method: String,
    headers_json: String,
    body: String,
) -> rquickjs::Result<Value<'js>> {
    let headers: Vec<(String, String)> =
        serde_json::from_str(&headers_json).unwrap_or_default();

    let (status, resp_headers, body_bytes) =
        do_request(&url, &method, &headers, &body)
            .map_err(|e| Exception::throw_message(&ctx, &format!("fetch failed: {e}")))?;

    let header_arr = rquickjs::Array::new(ctx.clone())?;
    for (i, (name, value)) in resp_headers.iter().enumerate() {
        let pair = rquickjs::Array::new(ctx.clone())?;
        pair.set(0usize, name.as_str())?;
        pair.set(1usize, value.as_str())?;
        header_arr.set(i, pair)?;
    }

    let result = Object::new(ctx.clone())?;
    result.set("status", status as u32)?;
    result.set("headers", header_arr)?;
    result.set("body", helpers::new_buffer_from_bytes(&ctx, &body_bytes)?)?;

    Ok(result.into_value())
}

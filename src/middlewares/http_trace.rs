use actix_web::body::{self, BodySize, BoxBody, MessageBody};
use actix_web::HttpMessage;
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::http::header::{HeaderMap, CONTENT_LENGTH, CONTENT_TYPE, USER_AGENT};
use actix_web::HttpResponseBuilder;
use actix_web::middleware::Next;
use actix_web::Error;
use actix_web::HttpResponse;
use bytes::Bytes;
use tracing::Instrument;

const MAX_TRACE_BODY_BYTES: usize = 256 * 1024;

const HOP_HEADERS: [&str; 6] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
];

pub(crate) struct ApiV1TraceMeta {
    pub host: String,
    pub path: String,
    pub query: String,
    pub path_params: String,
    pub request_headers: String,
    pub content_type: Option<String>,
    pub user_agent: Option<String>,
    pub request_body_len: Option<usize>,
    pub request_body_preview: Option<String>,
    pub request_body_note: Option<String>,
}

impl Default for ApiV1TraceMeta {
    fn default() -> Self {
        Self {
            host: String::new(),
            path: String::new(),
            query: String::new(),
            path_params: String::new(),
            request_headers: String::new(),
            content_type: None,
            user_agent: None,
            request_body_len: None,
            request_body_preview: None,
            request_body_note: None,
        }
    }
}

fn parse_content_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
}

fn response_body_length_hint(headers: &HeaderMap, body_size: BodySize) -> Option<usize> {
    let cl = parse_content_length(headers);
    match body_size {
        BodySize::Sized(n) => Some(n as usize),
        BodySize::None => cl.or(Some(0)),
        BodySize::Stream => cl,
    }
}

fn is_sensitive_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization")
        || name.eq_ignore_ascii_case("cookie")
        || name.eq_ignore_ascii_case("set-cookie")
}

fn safe_headers_preview(headers: &HeaderMap) -> String {
    let mut parts = Vec::new();
    let mut total = 0usize;
    for (name, value) in headers.iter() {
        let name_s = name.as_str();
        if HOP_HEADERS.iter().any(|h| name_s.eq_ignore_ascii_case(h)) {
            continue;
        }
        let piece = if is_sensitive_header(name_s) {
            format!("{name_s}=[redacted]")
        } else {
            let v = value.to_str().unwrap_or("[non-utf8]");
            let v: String = v.chars().take(512).collect();
            format!("{name_s}={v}")
        };
        total += piece.len() + 2;
        if total > 4096 {
            parts.push("...(headers truncated)".to_string());
            break;
        }
        parts.push(piece);
    }
    parts.join(", ")
}

fn match_info_kv(req: &ServiceRequest) -> String {
    req.match_info()
        .iter()
        .map(|(k, v)| {
            let v = v.replace('\n', " ").replace('\r', " ");
            format!("{k}={v}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn preview_bytes(data: &[u8]) -> String {
    let s = String::from_utf8_lossy(data);
    let s: String = s
        .chars()
        .map(|c| if c.is_control() && c != '\n' && c != '\t' { ' ' } else { c })
        .collect();
    crate::libs::string::truncate_chars_for_log(&s)
}

fn copy_headers_to_response_builder(src: &HeaderMap, dst: &mut HttpResponseBuilder) {
    for (name, value) in src.iter() {
        let name_s = name.as_str();
        if HOP_HEADERS.iter().any(|h| name_s.eq_ignore_ascii_case(h)) {
            continue;
        }
        dst.append_header((name.clone(), value.clone()));
    }
}

fn copy_headers_for_sized_body(src: &HeaderMap, dst: &mut HttpResponseBuilder) {
    for (name, value) in src.iter() {
        let name_s = name.as_str();
        if HOP_HEADERS.iter().any(|h| name_s.eq_ignore_ascii_case(h)) {
            continue;
        }
        if name_s.eq_ignore_ascii_case("content-length")
            || name_s.eq_ignore_ascii_case("transfer-encoding")
        {
            continue;
        }
        dst.append_header((name.clone(), value.clone()));
    }
}

async fn prepare_api_v1_request(req: ServiceRequest) -> Result<(ServiceRequest, ApiV1TraceMeta), Error> {
    let mut meta = ApiV1TraceMeta::default();
    meta.host = req.connection_info().host().to_string();
    meta.path = req.path().to_string();
    meta.query = req.uri().query().unwrap_or("").to_string();
    meta.path_params = match_info_kv(&req);
    meta.request_headers = safe_headers_preview(req.headers());
    meta.content_type = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    meta.user_agent = req
        .headers()
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let method = req.method().as_str();
    if matches!(method, "GET" | "HEAD" | "CONNECT" | "TRACE") {
        return Ok((req, meta));
    }

    let cl = match parse_content_length(req.headers()) {
        Some(n) => n,
        None => {
            meta.request_body_note =
                Some("no Content-Length: request body not buffered (chunked/unknown size)".into());
            return Ok((req, meta));
        }
    };

    if cl > MAX_TRACE_BODY_BYTES {
        meta.request_body_note = Some(format!(
            "Content-Length {cl} exceeds trace buffer max {MAX_TRACE_BODY_BYTES}"
        ));
        return Ok((req, meta));
    }

    let (http_req, pl) = req.into_parts();
    let stream = body::BodyStream::new(pl);
    let bytes = match body::to_bytes_limited(stream, cl).await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => return Err(Error::from(e)),
        Err(_) => return Err(actix_web::error::PayloadError::Overflow.into()),
    };

    meta.request_body_len = Some(bytes.len());
    if !bytes.is_empty() {
        meta.request_body_preview = Some(preview_bytes(&bytes));
    }
    Ok((ServiceRequest::from_parts(http_req, bytes.into()), meta))
}

fn record_request_meta(span: &tracing::Span, meta: &ApiV1TraceMeta) {
    if !meta.host.is_empty() && !meta.path.is_empty() {
        let url = if meta.query.is_empty() {
            format!("http://{}{}", meta.host, meta.path)
        } else {
            format!("http://{}{}?{}", meta.host, meta.path, meta.query)
        };
        span.record("http.url", url.as_str());
    }
    if !meta.query.is_empty() {
        span.record("url.query", meta.query.as_str());
    }
    if !meta.path_params.is_empty() {
        span.record("baal.path_params", meta.path_params.as_str());
    }
    if !meta.request_headers.is_empty() {
        span.record("baal.request.headers", meta.request_headers.as_str());
    }
    if let Some(ref ct) = meta.content_type {
        span.record("http.request.header.content_type", ct.as_str());
    }
    if let Some(ref ua) = meta.user_agent {
        span.record("user_agent.original", ua.as_str());
    }
    if let Some(n) = meta.request_body_len {
        span.record("baal.request.body.bytes", n as i64);
    }
    if let Some(ref p) = meta.request_body_preview {
        span.record("baal.request.body.preview", p.as_str());
    }
    if let Some(ref n) = meta.request_body_note {
        span.record("baal.request.body.note", n.as_str());
    }
}

async fn finish_api_v1_response<B: MessageBody + 'static>(
    span: tracing::Span,
    meta: ApiV1TraceMeta,
    res: ServiceResponse<B>,
) -> Result<ServiceResponse<BoxBody>, Error> {
    if let Some(ids) = res.request().extensions().get::<crate::telemetry::BaalHttpTriggerTraceIds>() {
        if let Some(rel) = ids.release_id {
            span.record("baal.release.id", tracing::field::display(rel));
        }
        if let Some(rid) = ids.runtime_id {
            span.record("baal.runtime.id", tracing::field::display(rid));
        }
    }
    record_request_meta(&span, &meta);

    let status = res.status();
    span.record("http.response.status_code", status.as_u16());

    let (req, resp) = res.into_parts();
    let headers = resp.headers().clone();
    let orig_body = resp.into_body();

    let bytes: Bytes = match orig_body.try_into_bytes() {
        Ok(b) => b,
        Err(body) => {
            let hint = response_body_length_hint(&headers, body.size());
            match hint {
                Some(n) if n <= MAX_TRACE_BODY_BYTES => match body::to_bytes_limited(body, n).await {
                    Ok(Ok(b)) => b,
                    Ok(Err(_e)) => {
                        return Err(actix_web::error::ErrorInternalServerError(
                            "response body stream error",
                        ));
                    }
                    Err(_) => return Err(actix_web::error::PayloadError::Overflow.into()),
                },
                Some(n) => {
                    let mut b = HttpResponse::build(status);
                    copy_headers_to_response_builder(&headers, &mut b);
                    let mut out = b.body(body).map_into_boxed_body();
                    crate::telemetry::inject_trace_response_headers_for_span(&span, out.headers_mut());
                    let response_headers = safe_headers_preview(out.headers());
                    span.record("baal.response.headers", response_headers.as_str());
                    span.record("baal.response.body.preview", "");
                    span.record("baal.response.body.bytes", n as i64);
                    let note = format!("not buffered: body length {n} > {MAX_TRACE_BODY_BYTES}");
                    span.record("baal.response.body.note", note.as_str());
                    return Ok(ServiceResponse::new(req, out));
                }
                None => {
                    let mut b = HttpResponse::build(status);
                    copy_headers_to_response_builder(&headers, &mut b);
                    let mut out = b.body(body).map_into_boxed_body();
                    crate::telemetry::inject_trace_response_headers_for_span(&span, out.headers_mut());
                    let response_headers = safe_headers_preview(out.headers());
                    span.record("baal.response.headers", response_headers.as_str());
                    span.record("baal.response.body.preview", "");
                    span.record("baal.response.body.bytes", 0i64);
                    span.record(
                        "baal.response.body.note",
                        "not buffered: unknown body length (streaming)",
                    );
                    return Ok(ServiceResponse::new(req, out));
                }
            }
        }
    };

    let n = bytes.len();
    let (resp_preview, resp_note): (Option<String>, String) = if n > MAX_TRACE_BODY_BYTES {
        (
            None,
            format!("preview omitted: body length {n} > {MAX_TRACE_BODY_BYTES}"),
        )
    } else if bytes.is_empty() {
        (None, String::new())
    } else {
        (Some(preview_bytes(&bytes)), String::new())
    };

    if let Some(ref pv) = resp_preview {
        span.record("baal.response.body.preview", pv.as_str());
    } else {
        span.record("baal.response.body.preview", "");
    }
    if !resp_note.is_empty() {
        span.record("baal.response.body.note", resp_note.as_str());
    } else {
        span.record("baal.response.body.note", "");
    }
    span.record("baal.response.body.bytes", n as i64);
    if let Some(ct) = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        span.record("http.response.header.content_type", ct);
    }

    let mut builder = HttpResponse::build(status);
    copy_headers_for_sized_body(&headers, &mut builder);
    let mut built = builder.body(bytes);
    crate::telemetry::inject_trace_response_headers_for_span(&span, built.headers_mut());
    let response_headers = safe_headers_preview(built.headers());
    span.record("baal.response.headers", response_headers.as_str());
    Ok(ServiceResponse::new(req, built.map_into_boxed_body()))
}

pub async fn trace_request_middleware<B: MessageBody + 'static>(
    req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<BoxBody>, Error> {
    let path = req.path().to_string();
    let (trace_pid, trace_rid) = crate::telemetry::telemetry_from_api_path(&path);
    let trigger_runtime = match (&trace_pid, &trace_rid) {
        (_, Some(_)) => Some("stage"),
        (Some(_), None) if path.starts_with("/api/v1/trigger") || path.starts_with("/api/v1/ws") => {
            Some("production")
        }
        _ => None,
    };
    let parent = crate::telemetry::context_with_telemetry_baggage(
        crate::telemetry::extract_context_from_header_map(req.headers()),
        trace_pid.as_deref(),
        trigger_runtime,
        trace_rid.as_deref(),
    );
    let method = req.method().as_str().to_string();
    let peer = req
        .connection_info()
        .peer_addr()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let host = req.connection_info().host().to_string();
    let trigger_entry = if path.starts_with("/api/v1/trigger/wf") {
        "workflow"
    } else if path.starts_with("/api/v1/trigger/actor") {
        "actor"
    } else if path.starts_with("/api/v1/trigger/workerQueue") {
        "queue_worker"
    } else if path.starts_with("/api/v1/trigger/") {
        "api_unit"
    } else {
        ""
    };

    let api_v1 = path.starts_with("/api/v1/");
    let (req, meta) = if api_v1 {
        prepare_api_v1_request(req).await?
    } else {
        (req, ApiV1TraceMeta::default())
    };

    async move {
        let _guard = parent.attach();
        let span = if api_v1 {
            tracing::info_span!(
                "http.server.request",
                http.request.method = %method,
                http.route = %path,
                network.peer.address = %peer,
                server.address = %host,
                baal.trigger.entry = trigger_entry,
                baal.runtime.id = tracing::field::Empty,
                baal.release.id = tracing::field::Empty,
                http.url = tracing::field::Empty,
                url.query = tracing::field::Empty,
                baal.path_params = tracing::field::Empty,
                baal.request.headers = tracing::field::Empty,
                http.request.header.content_type = tracing::field::Empty,
                user_agent.original = tracing::field::Empty,
                baal.request.body.bytes = tracing::field::Empty,
                baal.request.body.preview = tracing::field::Empty,
                baal.request.body.note = tracing::field::Empty,
                http.response.status_code = tracing::field::Empty,
                http.response.header.content_type = tracing::field::Empty,
                baal.response.headers = tracing::field::Empty,
                baal.response.body.bytes = tracing::field::Empty,
                baal.response.body.preview = tracing::field::Empty,
                baal.response.body.note = tracing::field::Empty,
            )
        } else {
            tracing::info_span!(
                "http.server.request",
                http.request.method = %method,
                http.route = %path,
                network.peer.address = %peer,
                server.address = %host,
                baal.trigger.entry = trigger_entry,
            )
        };
        if api_v1 {
            if let Some(ref rid) = trace_rid {
                if !rid.is_empty() {
                    span.record("baal.runtime.id", rid.as_str());
                }
            }
        }
        let res = next.call(req).instrument(span.clone()).await?;
        if api_v1 {
            finish_api_v1_response(span, meta, res).await
        } else {
            let mut res = res.map_into_boxed_body();
            crate::telemetry::inject_trace_response_headers_for_span(&span, res.headers_mut());
            Ok(res)
        }
    }
    .await
}

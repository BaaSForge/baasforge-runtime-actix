use opentelemetry::baggage::BaggageExt;
use opentelemetry::global;
use opentelemetry::trace::{
    Span as OtelSdkSpanTrait, SpanContext, SpanKind, TraceContextExt, Tracer, TracerProvider as _,
};
use opentelemetry::Context;
use opentelemetry::KeyValue;
use opentelemetry::Value;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::export::trace::SpanData;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::resource::Resource;
use opentelemetry_sdk::trace::{Sampler, Span, SpanProcessor, TracerProvider};
use std::collections::HashMap;
use std::sync::Once;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::filter::{EnvFilter, LevelFilter};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Registry;

static INIT: Once = Once::new();

const DEFAULT_OTLP_ENDPOINT: &str = "http://127.0.0.1:4317";

const BAGGAGE_TRIGGER_RUNTIME: &str = "baal.app.environment";
const BAGGAGE_PROJECT: &str = "baal.project.id";
const BAGGAGE_RUNTIME: &str = "baal.runtime.id";

pub fn telemetry_from_api_path(path: &str) -> (Option<String>, Option<String>) {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 4 || parts[0] != "api" || parts[1] != "v1" {
        return (None, None);
    }
    match parts[2] {
        "ws" => {
            let project_id = parts.get(3).map(|s| s.to_string());
            let runtime_id = if parts.get(4) == Some(&"stage") {
                parts.get(5).map(|s| s.to_string())
            } else {
                None
            };
            (project_id, runtime_id)
        }
        "trigger" => {
            let after_trigger = parts.get(3..).unwrap_or(&[]);
            if after_trigger.is_empty() {
                return (None, None);
            }
            let pid_slice = match after_trigger[0] {
                "wf" | "actor" | "workerQueue" => {
                    if after_trigger.len() < 2 {
                        return (None, None);
                    }
                    &after_trigger[1..]
                }
                _ => after_trigger,
            };
            let project_id = pid_slice.first().map(|s| s.to_string());
            let runtime_id = if pid_slice.get(1) == Some(&"stage") {
                pid_slice.get(2).map(|s| s.to_string())
            } else {
                None
            };
            (project_id, runtime_id)
        }
        _ => (None, None),
    }
}

pub fn context_with_telemetry_baggage(
    base: Context,
    project_id: Option<&str>,
    trigger_runtime: Option<&'static str>,
    stage_runtime_id: Option<&str>,
) -> Context {
    let mut kvs: Vec<KeyValue> = Vec::new();
    if let Some(t) = trigger_runtime {
        kvs.push(KeyValue::new(BAGGAGE_TRIGGER_RUNTIME, t.to_string()));
    }
    if let Some(pid) = project_id.filter(|s| !s.is_empty()) {
        kvs.push(KeyValue::new(BAGGAGE_PROJECT, pid.to_string()));
    }
    if trigger_runtime == Some("stage") {
        if let Some(r) = stage_runtime_id.filter(|s| !s.is_empty()) {
            kvs.push(KeyValue::new(BAGGAGE_RUNTIME, r.to_string()));
        }
    }
    if kvs.is_empty() {
        base
    } else {
        base.with_baggage(kvs)
    }
}

fn baggage_value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.as_str().to_string()),
        _ => None,
    }
}

#[derive(Debug)]
struct BaalSpanEnrichProcessor;

impl SpanProcessor for BaalSpanEnrichProcessor {
    fn on_start(&self, span: &mut Span, cx: &Context) {
        let baggage = cx.baggage();
        if let Some(v) = baggage
            .get(BAGGAGE_TRIGGER_RUNTIME)
            .and_then(baggage_value_to_string)
        {
            OtelSdkSpanTrait::set_attribute(span, KeyValue::new("baal.app.environment", v));
        }
        if let Some(v) = baggage.get(BAGGAGE_PROJECT).and_then(baggage_value_to_string) {
            OtelSdkSpanTrait::set_attribute(span, KeyValue::new("baal.project.id", v));
        }
        if let Some(v) = baggage.get(BAGGAGE_RUNTIME).and_then(baggage_value_to_string) {
            OtelSdkSpanTrait::set_attribute(span, KeyValue::new("baal.runtime.id", v));
        }
    }

    fn on_end(&self, _span: SpanData) {}

    fn force_flush(&self) -> opentelemetry::trace::TraceResult<()> {
        Ok(())
    }

    fn shutdown(&self) -> opentelemetry::trace::TraceResult<()> {
        Ok(())
    }
}

pub fn load_dotenv_for_telemetry() {
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename_override(".env.local").ok();
}

pub fn init_tracing(service_name: &'static str) {
    INIT.call_once(|| {
        load_dotenv_for_telemetry();

        let _ = tracing_log::LogTracer::init();

        let filter = EnvFilter::builder()
            .with_default_directive(LevelFilter::INFO.into())
            .from_env_lossy();

        global::set_text_map_propagator(TraceContextPropagator::new());

        let sdk_disabled = std::env::var("OTEL_SDK_DISABLED")
            .ok()
            .map(|s| s.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let traces_exporter_none = std::env::var("OTEL_TRACES_EXPORTER")
            .ok()
            .map(|s| s.eq_ignore_ascii_case("none"))
            .unwrap_or(false);

        let otlp_endpoint = if sdk_disabled || traces_exporter_none {
            None
        } else {
            let from_env = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                });
            match from_env {
                Some(e) => Some(e),
                None => {
                    let ci = std::env::var("CI").ok().as_deref() == Some("true");
                    if ci {
                        None
                    } else {
                        eprintln!(
                            "OTEL_EXPORTER_OTLP_ENDPOINT not set; using default {DEFAULT_OTLP_ENDPOINT} (Jaeger: docker compose -f docker-compose.telemetry.yml). Set OTEL_SDK_DISABLED=true or OTEL_TRACES_EXPORTER=none to skip."
                        );
                        Some(DEFAULT_OTLP_ENDPOINT.to_string())
                    }
                }
            }
        };

        if let Some(endpoint) = otlp_endpoint {
            let name = std::env::var("OTEL_SERVICE_NAME")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| service_name.to_string());

            let dep_env = std::env::var("DEPLOYMENT_ENVIRONMENT")
                .unwrap_or_else(|_| "unset".to_string());
            let resource = Resource::new(vec![
                KeyValue::new("service.name", name.clone()),
                KeyValue::new("deployment.environment.name", dep_env),
            ]);

            let exporter = match opentelemetry_otlp::SpanExporter::builder()
                .with_tonic()
                .with_endpoint(endpoint.clone())
                .build()
            {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("OTLP span exporter build failed ({e}); falling back to stderr-only tracing");
                    install_fmt_only(filter);
                    return;
                }
            };

            let provider = TracerProvider::builder()
                .with_sampler(Sampler::AlwaysOn)
                .with_span_processor(BaalSpanEnrichProcessor)
                .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
                .with_resource(resource)
                .build();

            let tracer = provider.tracer(name.clone());
            let _ = global::set_tracer_provider(provider);

            let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

            if Registry::default()
                .with(filter)
                .with(tracing_subscriber::fmt::layer())
                .with(otel_layer)
                .try_init()
                .is_err()
            {
                eprintln!("tracing subscriber init failed (already initialized?)");
            }
        } else {
            install_fmt_only(filter);
        }
    });
}

fn install_fmt_only(filter: EnvFilter) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init();
}

pub fn shutdown() {
    global::shutdown_tracer_provider();
}

pub fn otel_context_current() -> opentelemetry::Context {
    opentelemetry::Context::current()
}

pub fn extract_context_from_header_map(
    headers: &actix_web::http::header::HeaderMap,
) -> opentelemetry::Context {
    let mut carrier: HashMap<String, String> = HashMap::new();
    for key in ["traceparent", "tracestate"] {
        if let Some(v) = headers
            .get(key)
            .and_then(|h| h.to_str().ok())
        {
            carrier.insert(key.to_string(), v.to_string());
        }
    }
    global::get_text_map_propagator(|prop| prop.extract(&carrier))
}

pub fn inject_trace_response_headers_for_span(
    span: &tracing::Span,
    headers: &mut actix_web::http::header::HeaderMap,
) {
    let ctx = span.context();
    let mut carrier: HashMap<String, String> = HashMap::new();
    global::get_text_map_propagator(|prop| {
        prop.inject_context(&ctx, &mut carrier);
    });
    for (k, v) in carrier {
        if let (Ok(name), Ok(val)) = (
            actix_web::http::header::HeaderName::try_from(k.as_str()),
            actix_web::http::header::HeaderValue::try_from(v.as_str()),
        ) {
            let _ = headers.insert(name, val);
        }
    }
    let span_ref = ctx.span();
    let sc = span_ref.span_context();
    if sc.is_valid() {
        let hex = format!("{}", sc.trace_id());
        if let (Ok(n), Ok(v)) = (
            actix_web::http::header::HeaderName::try_from("X-Trace-Id"),
            actix_web::http::header::HeaderValue::try_from(hex.as_str()),
        ) {
            let _ = headers.insert(n, v);
        }
    }
}

pub fn inject_trace_response_headers(headers: &mut actix_web::http::header::HeaderMap) {
    inject_trace_response_headers_for_span(&tracing::Span::current(), headers);
}

pub fn traceparent_for_current_context() -> Option<String> {
    let span = tracing::Span::current();
    let ctx = span.context();
    let mut carrier: HashMap<String, String> = HashMap::new();
    global::get_text_map_propagator(|prop| {
        prop.inject_context(&ctx, &mut carrier);
    });
    carrier.get("traceparent").cloned()
}

pub fn trace_id_hex_current() -> Option<String> {
    let cx = tracing::Span::current().context();
    let span_ref = cx.span();
    let sc = span_ref.span_context();
    if sc.is_valid() {
        Some(format!("{}", sc.trace_id()))
    } else {
        None
    }
}

pub fn inject_traceparent_json_field(map: &mut serde_json::Map<String, serde_json::Value>) {
    let mut carrier: HashMap<String, String> = HashMap::new();
    global::get_text_map_propagator(|prop| {
        prop.inject_context(&opentelemetry::Context::current(), &mut carrier);
    });
    if let Some(tp) = carrier.get("traceparent") {
        map.insert(
            "traceparent".to_string(),
            serde_json::Value::String(tp.clone()),
        );
    }
    if let Some(ts) = carrier.get("tracestate") {
        map.insert(
            "tracestate".to_string(),
            serde_json::Value::String(ts.clone()),
        );
    }
}

fn trace_carrier_from_json(payload: &serde_json::Value) -> HashMap<String, String> {
    let mut carrier: HashMap<String, String> = HashMap::new();
    if let Some(s) = payload.get("traceparent").and_then(|v| v.as_str()) {
        carrier.insert("traceparent".to_string(), s.to_string());
    }
    if let Some(s) = payload.get("tracestate").and_then(|v| v.as_str()) {
        carrier.insert("tracestate".to_string(), s.to_string());
    }
    carrier
}

pub fn extract_context_from_json_value(payload: &serde_json::Value) -> opentelemetry::Context {
    let carrier = trace_carrier_from_json(payload);
    if carrier.is_empty() {
        return opentelemetry::Context::new();
    }
    global::get_text_map_propagator(|prop| prop.extract(&carrier))
}

pub fn attach_context_from_json_value(
    payload: &serde_json::Value,
) -> Option<opentelemetry::ContextGuard> {
    let carrier = trace_carrier_from_json(payload);
    if carrier.is_empty() {
        return None;
    }
    let ctx = global::get_text_map_propagator(|prop| prop.extract(&carrier));
    Some(ctx.attach())
}

pub fn inject_traceparent_string_map(carrier: &mut HashMap<String, String>) {
    global::get_text_map_propagator(|prop| {
        prop.inject_context(&opentelemetry::Context::current(), carrier);
    });
}

pub fn extract_context_from_string_map(
    carrier: &HashMap<String, String>,
) -> opentelemetry::Context {
    global::get_text_map_propagator(|prop| prop.extract(carrier))
}

/// HTTP and in-process SDK calls stay on one trace. When `traceparent` is present on the NATS
/// payload, consumer spans **continue that trace** as children of the producer; otherwise they
/// start a new root trace. `baal.trigger.*` attributes are always set when correlation is present.
#[derive(Clone, Debug)]
pub struct TriggerCorrelation {
    pub trace_id_hex: Option<String>,
    pub span_id_hex: Option<String>,
    pub producer_span_context: Option<SpanContext>,
}

impl TriggerCorrelation {
    pub fn empty() -> Self {
        Self {
            trace_id_hex: None,
            span_id_hex: None,
            producer_span_context: None,
        }
    }
}

/// W3C `traceparent`: `{version}-{trace_id}-{parent_span_id}-{flags}` (lowercase hex).
pub fn parse_traceparent_hex(traceparent: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = traceparent.split('-').collect();
    if parts.len() != 4 {
        return None;
    }
    let (ver, tid, pid, fl) = (parts[0], parts[1], parts[2], parts[3]);
    if ver.len() != 2 || tid.len() != 32 || pid.len() != 16 || fl.len() != 2 {
        return None;
    }
    let hex_ok = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    if !hex_ok(ver) || !hex_ok(tid) || !hex_ok(pid) || !hex_ok(fl) {
        return None;
    }
    Some((tid.to_ascii_lowercase(), pid.to_ascii_lowercase()))
}

pub fn trigger_correlation_from_payload(payload: &serde_json::Value) -> TriggerCorrelation {
    let producer_ctx = extract_context_from_json_value(payload);
    let sc = {
        let s = producer_ctx.span();
        s.span_context().clone()
    };
    if !sc.is_valid() {
        return TriggerCorrelation::empty();
    }
    TriggerCorrelation {
        trace_id_hex: Some(format!("{}", sc.trace_id())),
        span_id_hex: Some(format!("{}", sc.span_id())),
        producer_span_context: Some(sc),
    }
}

/// OTel context for one async consumer execution (`baal.trigger.*` on the span).
/// Use with [`opentelemetry::trace::FutureExt::with_context`] on the async handler future so each poll
/// attaches the context without holding a non-`Send` [`ContextGuard`] across `await`.
pub fn async_consumer_context(
    correlation: &TriggerCorrelation,
    span_name: &'static str,
    trigger_source: &'static str,
    project_id: Option<&str>,
    trigger_runtime: Option<&'static str>,
    stage_runtime_id: Option<&str>,
) -> Context {
    let tracer = global::tracer("baal.async_consumer");
    let parent_cx = correlation
        .producer_span_context
        .as_ref()
        .filter(|sc| sc.is_valid())
        .map(|sc| Context::new().with_remote_span_context(sc.clone()))
        .unwrap_or_default();
    let mut attrs: Vec<KeyValue> = vec![KeyValue::new("baal.trigger.source", trigger_source.to_string())];
    if let Some(ref t) = correlation.trace_id_hex {
        attrs.push(KeyValue::new("baal.trigger.trace_id", t.clone()));
    }
    if let Some(ref s) = correlation.span_id_hex {
        attrs.push(KeyValue::new("baal.trigger.span_id", s.clone()));
    }
    let builder = tracer
        .span_builder(span_name)
        .with_kind(SpanKind::Consumer)
        .with_attributes(attrs);
    let span = builder.start_with_context(&tracer, &parent_cx);
    let cx = Context::current_with_span(span);
    context_with_telemetry_baggage(cx, project_id, trigger_runtime, stage_runtime_id)
}

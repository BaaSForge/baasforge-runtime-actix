use serde::{Deserialize, Serialize};

/// Snapshot of the incoming request passed into JS as `req`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerHttpSnapshot {
    pub method: String,
    /// Path and query only, e.g. `/foo?a=1`.
    pub url: String,
    pub header_pairs: Vec<(String, String)>,
    pub body_text: String,
    /// Full original request path (before query), used for self-referencing fetch.
    pub trigger_path: String,
}

/// Response captured from the JS `res` object after `handleRequest` completes.
#[derive(Debug)]
pub struct TriggerHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Raw shape returned by `res.__snapshot()` in JS, deserialized via rquickjs-serde.
#[derive(Deserialize)]
pub struct JsResponseRaw {
    pub status: Option<u64>,
    pub headers: Option<Vec<JsHeaderPair>>,
    pub body: Option<String>,
}

#[derive(Deserialize)]
pub struct JsHeaderPair {
    pub name: String,
    pub value: String,
}

impl From<JsResponseRaw> for TriggerHttpResponse {
    fn from(raw: JsResponseRaw) -> Self {
        let status = raw.status.unwrap_or(200).min(599) as u16;
        let headers = raw
            .headers
            .unwrap_or_default()
            .into_iter()
            .filter(|h| !h.name.is_empty())
            .map(|h| (h.name, h.value))
            .collect();
        let body = raw.body.unwrap_or_default();
        Self {
            status,
            headers,
            body,
        }
    }
}

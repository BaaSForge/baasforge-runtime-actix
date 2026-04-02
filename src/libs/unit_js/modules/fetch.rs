use rquickjs::{Ctx, Exception, Object, Value, function::Func};

use crate::libs::unit_js::modules::helpers;

const FETCH_JS: &str = include_str!("../scripts/fetch.js");

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__fetch_sync", Func::from(fetch_sync))?;
    ctx.eval::<(), _>(FETCH_JS)?;
    ctx.eval::<(), _>("delete globalThis.__fetch_sync")?;
    Ok(())
}

fn do_request(
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: &str,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let agent = ureq::Agent::new_with_defaults();

    let resp = match method {
        "GET" => {
            let mut r = agent.get(url);
            for (n, v) in headers { r = r.header(n, v); }
            r.call().map_err(|e| format!("{e}"))
        }
        "HEAD" => {
            let mut r = agent.head(url);
            for (n, v) in headers { r = r.header(n, v); }
            r.call().map_err(|e| format!("{e}"))
        }
        "DELETE" => {
            let mut r = agent.delete(url);
            for (n, v) in headers { r = r.header(n, v); }
            r.call().map_err(|e| format!("{e}"))
        }
        "POST" => {
            let mut r = agent.post(url);
            for (n, v) in headers { r = r.header(n, v); }
            r.send(body.as_bytes()).map_err(|e| format!("{e}"))
        }
        "PUT" => {
            let mut r = agent.put(url);
            for (n, v) in headers { r = r.header(n, v); }
            r.send(body.as_bytes()).map_err(|e| format!("{e}"))
        }
        "PATCH" => {
            let mut r = agent.patch(url);
            for (n, v) in headers { r = r.header(n, v); }
            r.send(body.as_bytes()).map_err(|e| format!("{e}"))
        }
        other => return Err(format!("Unsupported HTTP method: {other}")),
    }?;

    let status = resp.status();

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

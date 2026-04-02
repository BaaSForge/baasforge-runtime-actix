use rquickjs::{Ctx, Exception, Object, Value, function::{Func, Opt}};

const URL_JS: &str = include_str!("../scripts/url.js");

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__parse_url", Func::from(parse_url))?;
    ctx.eval::<(), _>(URL_JS)?;
    ctx.eval::<(), _>("delete globalThis.__parse_url")?;
    Ok(())
}

fn parse_url<'js>(
    ctx: Ctx<'js>,
    input: String,
    base: Opt<String>,
) -> rquickjs::Result<Value<'js>> {
    let parsed = match base.0.as_deref() {
        Some(b) if !b.is_empty() => {
            let base_url = url::Url::parse(b)
                .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid URL: {e}")))?;
            base_url
                .join(&input)
                .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid URL: {e}")))?
        }
        _ => url::Url::parse(&input)
            .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid URL: {e}")))?,
    };

    let obj = Object::new(ctx.clone())?;
    obj.set("href", parsed.as_str())?;
    obj.set("protocol", format!("{}:", parsed.scheme()))?;
    obj.set(
        "hostname",
        parsed.host_str().unwrap_or("").to_string(),
    )?;
    obj.set(
        "port",
        parsed
            .port()
            .map(|p| p.to_string())
            .unwrap_or_default(),
    )?;
    obj.set("pathname", parsed.path().to_string())?;
    obj.set(
        "search",
        parsed
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default(),
    )?;
    obj.set(
        "hash",
        parsed
            .fragment()
            .map(|f| format!("#{f}"))
            .unwrap_or_default(),
    )?;

    let host = match (parsed.host_str(), parsed.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => String::new(),
    };
    obj.set("host", host)?;

    let origin = if parsed.scheme() == "blob" {
        "null".to_string()
    } else {
        let mut o = format!("{}://", parsed.scheme());
        if let Some(h) = parsed.host_str() {
            o.push_str(h);
        }
        if let Some(p) = parsed.port() {
            o.push(':');
            o.push_str(&p.to_string());
        }
        o
    };
    obj.set("origin", origin)?;
    obj.set("username", parsed.username().to_string())?;
    obj.set(
        "password",
        parsed.password().unwrap_or("").to_string(),
    )?;

    Ok(obj.into_value())
}

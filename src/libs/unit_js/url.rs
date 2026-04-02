use rquickjs::class::Trace;
use rquickjs::function::Constructor;
use rquickjs::{Class, Ctx, Exception, JsLifetime, Value};

/// Thin URL class backed by the `url` crate.
/// `URLSearchParams` comes from `rquickjs-extra-url` (the library).
#[derive(Trace, JsLifetime)]
#[rquickjs::class(rename = "URL")]
pub struct JsUrl {
    href_val: String,
    pathname_val: String,
    search_val: String,
}

#[rquickjs::methods]
impl JsUrl {
    #[qjs(constructor)]
    pub fn new(ctx: Ctx<'_>, input: String, base: rquickjs::function::Opt<String>) -> rquickjs::Result<Self> {
        let parsed = match base.0 {
            Some(b) => {
                let base_url = url::Url::parse(&b)
                    .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid URL: {e}")))?;
                base_url
                    .join(&input)
                    .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid URL: {e}")))?
            }
            None => url::Url::parse(&input)
                .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid URL: {e}")))?,
        };
        Ok(Self {
            href_val: parsed.as_str().to_string(),
            pathname_val: parsed.path().to_string(),
            search_val: parsed
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default(),
        })
    }

    #[qjs(get, rename = "href")]
    pub fn href(&self) -> String {
        self.href_val.clone()
    }

    #[qjs(get, rename = "pathname")]
    pub fn pathname(&self) -> String {
        self.pathname_val.clone()
    }

    #[qjs(get, rename = "search")]
    pub fn search(&self) -> String {
        self.search_val.clone()
    }

    #[qjs(get, rename = "searchParams")]
    pub fn search_params<'js>(&self, ctx: Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        let qs = self.search_val.strip_prefix('?').unwrap_or("");
        let ctor: Constructor<'js> = ctx.globals().get("URLSearchParams")?;
        ctor.construct((qs,))
    }
}

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    rquickjs_extra_url::init(ctx)?;
    Class::<JsUrl>::define(&ctx.globals())?;
    Ok(())
}

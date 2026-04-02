use rquickjs::class::Trace;
use rquickjs::function::Opt;
use rquickjs::{Class, Ctx, Exception, JsLifetime, Object, Value};

#[derive(Trace, JsLifetime)]
#[rquickjs::class(rename = "TextEncoder")]
pub struct JsTextEncoder {
    _priv: (),
}

#[rquickjs::methods]
impl JsTextEncoder {
    #[qjs(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { _priv: () }
    }

    #[qjs(get)]
    pub fn encoding(&self) -> String {
        "utf-8".into()
    }

    pub fn encode<'js>(&self, ctx: Ctx<'js>, input: Opt<String>) -> rquickjs::Result<Value<'js>> {
        let s = input.0.unwrap_or_default();
        let bytes = s.as_bytes();
        super::helpers::new_uint8array(&ctx, bytes)
    }

    #[qjs(rename = "encodeInto")]
    pub fn encode_into<'js>(
        &self,
        ctx: Ctx<'js>,
        src: String,
        dest: Value<'js>,
    ) -> rquickjs::Result<Value<'js>> {
        let dest_obj = dest
            .as_object()
            .ok_or_else(|| Exception::throw_message(&ctx, "expected Uint8Array"))?;
        let dest_len: usize = dest_obj.get("length")?;

        let mut read: usize = 0;
        let mut written: usize = 0;

        for ch in src.chars() {
            let ch_utf8_len = ch.len_utf8();
            if written + ch_utf8_len > dest_len {
                break;
            }
            let mut buf = [0u8; 4];
            ch.encode_utf8(&mut buf);
            for byte in &buf[..ch_utf8_len] {
                dest_obj.set(written as u32, *byte as u32)?;
                written += 1;
            }
            read += ch.len_utf16();
        }

        let result = Object::new(ctx.clone())?;
        result.set("read", read)?;
        result.set("written", written)?;
        Ok(result.into_value())
    }
}

#[derive(Trace, JsLifetime)]
#[rquickjs::class(rename = "TextDecoder")]
pub struct JsTextDecoder {
    label: String,
    fatal: bool,
}

#[rquickjs::methods]
impl JsTextDecoder {
    #[qjs(constructor)]
    pub fn new(label: Opt<String>, options: Opt<Value<'_>>) -> rquickjs::Result<Self> {
        let label = label.0.unwrap_or_else(|| "utf-8".into()).to_lowercase();
        let fatal = if let Some(opts) = options.0 {
            if let Some(obj) = opts.as_object() {
                obj.get::<_, bool>("fatal").unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };
        Ok(Self { label, fatal })
    }

    #[qjs(get)]
    pub fn encoding(&self) -> String {
        self.label.clone()
    }

    pub fn decode<'js>(
        &self,
        ctx: Ctx<'js>,
        input: Opt<Value<'js>>,
    ) -> rquickjs::Result<String> {
        let bytes = match input.0 {
            Some(val) => super::helpers::get_bytes(&ctx, &val)?,
            None => Vec::new(),
        };

        if bytes.is_empty() {
            return Ok(String::new());
        }

        let data = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF
        {
            &bytes[3..]
        } else {
            &bytes
        };

        if self.fatal {
            String::from_utf8(data.to_vec())
                .map_err(|_| Exception::throw_message(&ctx, "The encoded data was not valid UTF-8"))
        } else {
            Ok(String::from_utf8_lossy(data).into_owned())
        }
    }
}

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    Class::<JsTextEncoder>::define(&ctx.globals())?;
    Class::<JsTextDecoder>::define(&ctx.globals())?;
    Ok(())
}

use rquickjs::{Array, Ctx, Exception, Value, function::Constructor};

pub fn new_uint8array<'js>(ctx: &Ctx<'js>, bytes: &[u8]) -> rquickjs::Result<Value<'js>> {
    let arr = Array::new(ctx.clone())?;
    for (i, &b) in bytes.iter().enumerate() {
        arr.set(i, b as u32)?;
    }
    let ctor: Constructor<'js> = ctx.globals().get("Uint8Array")?;
    ctor.construct((arr,))
}

pub fn get_bytes<'js>(ctx: &Ctx<'js>, val: &Value<'js>) -> rquickjs::Result<Vec<u8>> {
    let obj = val
        .as_object()
        .ok_or_else(|| Exception::throw_message(ctx, "expected TypedArray or ArrayBuffer"))?;

    if let Ok(len) = obj.get::<_, usize>("length") {
        let mut bytes = Vec::with_capacity(len);
        for i in 0..len {
            let b: u8 = obj.get(i as u32)?;
            bytes.push(b);
        }
        return Ok(bytes);
    }

    if let Ok(byte_len) = obj.get::<_, usize>("byteLength") {
        let uint8_ctor: Constructor<'js> = ctx.globals().get("Uint8Array")?;
        let view: Value<'js> = uint8_ctor.construct((val.clone(),))?;
        let view_obj = view
            .as_object()
            .ok_or_else(|| Exception::throw_message(ctx, "failed to wrap as Uint8Array"))?;
        let mut bytes = Vec::with_capacity(byte_len);
        for i in 0..byte_len {
            let b: u8 = view_obj.get(i as u32)?;
            bytes.push(b);
        }
        return Ok(bytes);
    }

    Err(Exception::throw_message(ctx, "cannot read bytes from value"))
}

pub fn new_buffer_from_bytes<'js>(ctx: &Ctx<'js>, bytes: &[u8]) -> rquickjs::Result<Value<'js>> {
    let arr = Array::new(ctx.clone())?;
    for (i, &b) in bytes.iter().enumerate() {
        arr.set(i, b as u32)?;
    }
    let buffer_obj: rquickjs::Object<'js> = ctx.globals().get("Buffer")?;
    let from_fn: rquickjs::Function<'js> = buffer_obj.get("from")?;
    from_fn.call((arr,))
}

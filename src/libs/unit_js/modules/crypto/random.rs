use ring::rand::SecureRandom;
use rquickjs::{Ctx, Exception, Value, function::Opt};

use crate::libs::unit_js::modules::helpers;

pub fn random_uuid() -> String {
    let rng = ring::rand::SystemRandom::new();
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes).expect("system rng failed");
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

pub fn random_bytes<'js>(ctx: Ctx<'js>, size: usize) -> rquickjs::Result<Value<'js>> {
    let rng = ring::rand::SystemRandom::new();
    let mut bytes = vec![0u8; size];
    rng.fill(&mut bytes)
        .map_err(|_| Exception::throw_message(&ctx, "random byte generation failed"))?;
    helpers::new_buffer_from_bytes(&ctx, &bytes)
}

pub fn random_int(ctx: Ctx<'_>, min_val: i64, max_val: Opt<i64>) -> rquickjs::Result<i64> {
    let (lo, hi) = match max_val.0 {
        Some(mx) => (min_val, mx),
        None => (0, min_val),
    };
    if lo >= hi {
        return Err(Exception::throw_message(
            &ctx,
            "max must be greater than min",
        ));
    }
    let range = (hi - lo) as u64;
    let rng = ring::rand::SystemRandom::new();
    let mut buf = [0u8; 8];
    rng.fill(&mut buf)
        .map_err(|_| Exception::throw_message(&ctx, "random generation failed"))?;
    let val = u64::from_le_bytes(buf);
    Ok(lo + (val % range) as i64)
}

pub fn random_fill_sync<'js>(ctx: Ctx<'js>, buf: Value<'js>) -> rquickjs::Result<Value<'js>> {
    let obj = buf
        .as_object()
        .ok_or_else(|| Exception::throw_message(&ctx, "expected Buffer"))?;
    let len: usize = obj.get("length")?;

    let rng = ring::rand::SystemRandom::new();
    let mut bytes = vec![0u8; len];
    rng.fill(&mut bytes)
        .map_err(|_| Exception::throw_message(&ctx, "random generation failed"))?;

    for (i, b) in bytes.into_iter().enumerate() {
        obj.set(i as u32, b as u32)?;
    }
    Ok(buf)
}

pub fn get_random_values<'js>(ctx: Ctx<'js>, buf: Value<'js>) -> rquickjs::Result<Value<'js>> {
    random_fill_sync(ctx, buf)
}

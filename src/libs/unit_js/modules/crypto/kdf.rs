use rquickjs::{Ctx, Exception, Value};

use crate::libs::unit_js::modules::helpers;

pub fn pbkdf2_sync<'js>(
    ctx: Ctx<'js>,
    password: Value<'js>,
    salt: Value<'js>,
    iterations: u32,
    key_len: usize,
    digest: String,
) -> rquickjs::Result<Value<'js>> {
    let pass_bytes = value_to_bytes(&ctx, &password)?;
    let salt_bytes = value_to_bytes(&ctx, &salt)?;

    let alg = match digest.to_lowercase().as_str() {
        "sha256" => ring::pbkdf2::PBKDF2_HMAC_SHA256,
        "sha384" => ring::pbkdf2::PBKDF2_HMAC_SHA384,
        "sha512" => ring::pbkdf2::PBKDF2_HMAC_SHA512,
        "sha1" => ring::pbkdf2::PBKDF2_HMAC_SHA1,
        other => {
            return Err(Exception::throw_message(
                &ctx,
                &format!("Unsupported PBKDF2 digest: {other}"),
            ));
        }
    };

    let iters =
        std::num::NonZeroU32::new(iterations).ok_or_else(|| {
            Exception::throw_message(&ctx, "iterations must be > 0")
        })?;

    let mut output = vec![0u8; key_len];
    ring::pbkdf2::derive(alg, iters, &salt_bytes, &pass_bytes, &mut output);
    helpers::new_buffer_from_bytes(&ctx, &output)
}

pub fn scrypt_sync<'js>(
    ctx: Ctx<'js>,
    password: Value<'js>,
    salt: Value<'js>,
    key_len: usize,
) -> rquickjs::Result<Value<'js>> {
    let pass_bytes = value_to_bytes(&ctx, &password)?;
    let salt_bytes = value_to_bytes(&ctx, &salt)?;

    let params = scrypt::Params::new(14, 8, 1, key_len)
        .map_err(|e| Exception::throw_message(&ctx, &format!("scrypt params error: {e}")))?;

    let mut output = vec![0u8; key_len];
    scrypt::scrypt(&pass_bytes, &salt_bytes, &params, &mut output)
        .map_err(|e| Exception::throw_message(&ctx, &format!("scrypt error: {e}")))?;

    helpers::new_buffer_from_bytes(&ctx, &output)
}

pub fn timing_safe_equal<'js>(
    ctx: Ctx<'js>,
    a: Value<'js>,
    b: Value<'js>,
) -> rquickjs::Result<bool> {
    let a_bytes = helpers::get_bytes(&ctx, &a)?;
    let b_bytes = helpers::get_bytes(&ctx, &b)?;

    if a_bytes.len() != b_bytes.len() {
        return Err(Exception::throw_message(
            &ctx,
            "Input buffers must have the same byte length",
        ));
    }

    let mut result: u8 = 0;
    for (x, y) in a_bytes.iter().zip(b_bytes.iter()) {
        result |= x ^ y;
    }
    Ok(result == 0)
}

fn value_to_bytes<'js>(ctx: &Ctx<'js>, val: &Value<'js>) -> rquickjs::Result<Vec<u8>> {
    if let Some(s) = val.as_string() {
        Ok(s.to_string()?.into_bytes())
    } else {
        helpers::get_bytes(ctx, val)
    }
}

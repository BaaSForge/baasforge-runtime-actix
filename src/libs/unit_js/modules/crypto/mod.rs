mod cipher;
mod hash;
mod hmac;
mod kdf;
mod random;

use rquickjs::{Ctx, function::Func};

const CRYPTO_JS: &str = include_str!("../../scripts/crypto.js");

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let g = ctx.globals();

    g.set("__crypto_digest", Func::from(hash::compute_digest_js))?;
    g.set("__crypto_hmac_digest", Func::from(hmac::compute_hmac_js))?;
    g.set("__crypto_cipher_process", Func::from(cipher::cipher_process_js))?;
    g.set("__crypto_random_uuid", Func::from(random::random_uuid))?;
    g.set("__crypto_random_bytes", Func::from(random::random_bytes))?;
    g.set("__crypto_random_int", Func::from(random::random_int))?;
    g.set("__crypto_random_fill_sync", Func::from(random::random_fill_sync))?;
    g.set("__crypto_get_random_values", Func::from(random::get_random_values))?;
    g.set("__crypto_pbkdf2_sync", Func::from(kdf::pbkdf2_sync))?;
    g.set("__crypto_scrypt_sync", Func::from(kdf::scrypt_sync))?;
    g.set("__crypto_timing_safe_equal", Func::from(kdf::timing_safe_equal))?;

    ctx.eval::<(), _>(CRYPTO_JS)?;

    ctx.eval::<(), _>(
        "delete globalThis.__crypto_digest;\
         delete globalThis.__crypto_hmac_digest;\
         delete globalThis.__crypto_cipher_process;\
         delete globalThis.__crypto_random_uuid;\
         delete globalThis.__crypto_random_bytes;\
         delete globalThis.__crypto_random_int;\
         delete globalThis.__crypto_random_fill_sync;\
         delete globalThis.__crypto_get_random_values;\
         delete globalThis.__crypto_pbkdf2_sync;\
         delete globalThis.__crypto_scrypt_sync;\
         delete globalThis.__crypto_timing_safe_equal;",
    )?;

    Ok(())
}

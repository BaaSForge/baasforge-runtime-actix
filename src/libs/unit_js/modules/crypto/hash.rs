use digest::Digest;
use rquickjs::{Ctx, Exception, Value};

use crate::libs::unit_js::modules::helpers;

pub fn compute_digest_js<'js>(
    ctx: Ctx<'js>,
    algorithm: String,
    data: Vec<u8>,
) -> rquickjs::Result<Value<'js>> {
    let hash = compute_digest_inner(&ctx, &algorithm, &data)?;
    helpers::new_buffer_from_bytes(&ctx, &hash)
}

fn compute_digest_inner(ctx: &Ctx<'_>, algorithm: &str, data: &[u8]) -> rquickjs::Result<Vec<u8>> {
    match algorithm {
        "sha256" => Ok(sha2::Sha256::digest(data).to_vec()),
        "sha384" => Ok(sha2::Sha384::digest(data).to_vec()),
        "sha512" => Ok(sha2::Sha512::digest(data).to_vec()),
        "sha1" => Ok(sha1::Sha1::digest(data).to_vec()),
        "md5" => Ok(md5::Md5::digest(data).to_vec()),
        other => Err(Exception::throw_message(
            ctx,
            &format!("Unsupported hash algorithm: {other}"),
        )),
    }
}

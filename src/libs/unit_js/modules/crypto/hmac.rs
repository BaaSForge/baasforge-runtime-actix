use digest::KeyInit;
use hmac::Mac;
use rquickjs::{Ctx, Exception, Value};

use crate::libs::unit_js::modules::helpers;

pub fn compute_hmac_js<'js>(
    ctx: Ctx<'js>,
    algorithm: String,
    key: Vec<u8>,
    data: Vec<u8>,
) -> rquickjs::Result<Value<'js>> {
    let result = compute_hmac_inner(&ctx, &algorithm, &key, &data)?;
    helpers::new_buffer_from_bytes(&ctx, &result)
}

fn compute_hmac_inner(
    ctx: &Ctx<'_>,
    algorithm: &str,
    key: &[u8],
    data: &[u8],
) -> rquickjs::Result<Vec<u8>> {
    macro_rules! hmac_compute {
        ($ty:ty) => {{
            let mut mac = <hmac::Hmac<$ty>>::new_from_slice(key)
                .map_err(|e| Exception::throw_message(ctx, &format!("{}", e)))?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }};
    }

    match algorithm {
        "sha256" => hmac_compute!(sha2::Sha256),
        "sha384" => hmac_compute!(sha2::Sha384),
        "sha512" => hmac_compute!(sha2::Sha512),
        "sha1" => hmac_compute!(sha1::Sha1),
        "md5" => hmac_compute!(md5::Md5),
        other => Err(Exception::throw_message(
            ctx,
            &format!("Unsupported HMAC algorithm: {other}"),
        )),
    }
}

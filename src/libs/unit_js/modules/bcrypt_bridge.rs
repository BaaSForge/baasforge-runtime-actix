use rquickjs::{Ctx, Exception, function::Func};

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__baal_bcrypt_compare_sync", Func::from(host_bcrypt_compare_sync))?;
    Ok(())
}

fn host_bcrypt_compare_sync(ctx: Ctx<'_>, password: String, hash: String) -> rquickjs::Result<bool> {
    if hash.len() != 60 {
        return Ok(false);
    }
    match bcrypt::verify(&password, &hash) {
        Ok(ok) => Ok(ok),
        Err(e) => Err(Exception::throw_message(&ctx, &e.to_string())),
    }
}

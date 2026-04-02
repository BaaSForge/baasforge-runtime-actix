use base64::{Engine as _, engine::general_purpose::STANDARD};
use rquickjs::{Ctx, Exception, function::Func};

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    globals.set("btoa", Func::from(btoa_impl))?;
    globals.set("atob", Func::from(atob_impl))?;
    Ok(())
}

fn btoa_impl(ctx: Ctx<'_>, input: String) -> rquickjs::Result<String> {
    let bytes: rquickjs::Result<Vec<u8>> = input
        .chars()
        .map(|c| {
            let code = c as u32;
            if code > 255 {
                Err(Exception::throw_message(
                    &ctx,
                    "InvalidCharacterError: btoa string contains characters outside latin1 range",
                ))
            } else {
                Ok(code as u8)
            }
        })
        .collect();
    Ok(STANDARD.encode(bytes?))
}

fn atob_impl(ctx: Ctx<'_>, input: String) -> rquickjs::Result<String> {
    let clean: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let padded = match clean.len() % 4 {
        2 => format!("{}==", clean),
        3 => format!("{}=", clean),
        _ => clean,
    };
    let bytes = STANDARD
        .decode(&padded)
        .map_err(|e| Exception::throw_message(&ctx, &format!("InvalidCharacterError: {e}")))?;
    Ok(bytes.into_iter().map(|b| b as char).collect())
}
